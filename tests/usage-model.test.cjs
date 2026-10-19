const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  WINDOW_MS,
  bindingLimit,
  resetCopy,
  usagePace,
  usageAlerts,
} = require('../src/usageModel.ts');

const NOW = Date.parse('2026-09-30T20:00:00Z');
const HOUR = 3_600_000;
const usage = (fiveHour, weekly, extra = {}) => ({
  provider: 'claude',
  status: 'ok',
  plan: 'pro',
  fiveHour,
  weekly,
  ...extra,
});

test('Pace marks how much of the window has passed', () => {
  // Two of five hours gone.
  const pace = usagePace({ percent: 10, resetsAt: NOW + 3 * HOUR }, WINDOW_MS.fiveHour, NOW);
  assert.equal(pace.elapsed, 0.4);
  assert.equal(pace.runsOutAt, null, '10% after 40% of the window will not run out');
  assert.deepEqual(usagePace({ percent: 0, resetsAt: null }, WINDOW_MS.fiveHour, NOW), {
    elapsed: null,
    runsOutAt: null,
    reached: false,
  });
});

test('Pace projects when the limit runs out before it resets', () => {
  // 60% used in the first two hours: 100% arrives 1h20m later, before the 3h reset.
  const pace = usagePace({ percent: 60, resetsAt: NOW + 3 * HOUR }, WINDOW_MS.fiveHour, NOW);
  assert.equal(pace.runsOutAt, NOW + (80 / 60) * HOUR);
  assert.equal(
    usagePace({ percent: 100, resetsAt: NOW + HOUR }, WINDOW_MS.fiveHour, NOW).reached,
    true,
  );
  // Too early in the window to project from.
  const early = usagePace({ percent: 8, resetsAt: NOW + 4.8 * HOUR }, WINDOW_MS.fiveHour, NOW);
  assert.equal(early.runsOutAt, null);
});

test('The binding limit is the fullest window, including per-model limits', () => {
  const five = { percent: 6, resetsAt: NOW + HOUR };
  const week = { percent: 27, resetsAt: NOW + 50 * HOUR };
  assert.deepEqual(bindingLimit(usage(five, week)), { label: 'Weekly', window: week });
  const opus = { percent: 81, resetsAt: NOW + 50 * HOUR };
  assert.deepEqual(
    bindingLimit(
      usage(five, week, { extras: [{ id: 'opus', label: 'Opus weekly', window: opus }] }),
    ),
    {
      label: 'Opus weekly',
      window: opus,
    },
  );
  assert.equal(bindingLimit(usage(null, null)), null);
});

test('Alerts fire once per threshold within a window', () => {
  const reset = NOW + 2 * HOUR;
  let result = usageAlerts({}, { claude: usage({ percent: 50, resetsAt: reset }, null) }, NOW);
  assert.equal(result.alerts.length, 0);
  result = usageAlerts(
    result.state,
    { claude: usage({ percent: 77, resetsAt: reset }, null) },
    NOW,
  );
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].title, 'Claude 5-hour usage at 77%');
  assert.match(result.alerts[0].detail, /Resets in 2h 0m/);
  assert.equal(result.alerts[0].success, false);
  result = usageAlerts(
    result.state,
    { claude: usage({ percent: 80, resetsAt: reset + 60_000 }, null) },
    NOW,
  );
  assert.equal(result.alerts.length, 0, 'a small reset-time jitter is the same window');
  result = usageAlerts(
    result.state,
    { claude: usage({ percent: 92, resetsAt: reset }, null) },
    NOW,
  );
  assert.equal(result.alerts[0].title, 'Claude 5-hour usage at 92%');
  result = usageAlerts(
    result.state,
    { claude: usage({ percent: 100, resetsAt: reset }, null) },
    NOW,
  );
  assert.equal(result.alerts[0].title, 'Claude 5-hour limit reached');
});

test('A window that resets after a warning announces it', () => {
  const reset = NOW + HOUR;
  const warned = usageAlerts(
    {},
    { codex: { ...usage({ percent: 91, resetsAt: reset }, null), provider: 'codex' } },
    NOW,
  );
  assert.equal(warned.alerts.length, 1);
  const after = usageAlerts(
    warned.state,
    { codex: { ...usage({ percent: 0, resetsAt: null }, null), provider: 'codex' } },
    reset + 1000,
  );
  assert.deepEqual(
    after.alerts.map((alert) => [alert.title, alert.success]),
    [['Codex 5-hour limit reset', true]],
  );
  const quiet = usageAlerts(
    after.state,
    { codex: { ...usage({ percent: 3, resetsAt: reset + 5 * HOUR }, null), provider: 'codex' } },
    reset + 2000,
  );
  assert.equal(quiet.alerts.length, 0);
});

test('Alerts ignore readings that are not current', () => {
  const stale = { ...usage({ percent: 95, resetsAt: NOW + HOUR }, null), status: 'stale' };
  const result = usageAlerts({}, { claude: stale }, NOW);
  assert.equal(result.alerts.length, 0);
  assert.deepEqual(result.state, {});
});

test('An ended window cannot produce a limit warning or a false reset notification', () => {
  const ended = { percent: 100, resetsAt: NOW - 1000, resetPending: true };
  const weekly = { percent: 20, resetsAt: NOW + HOUR };
  const before = { 'claude:fiveHour': { resetsAt: NOW - 1000, level: 90 } };
  const reading = usage(ended, weekly);
  assert.match(resetCopy(ended, NOW), /awaiting update/);
  assert.equal(usagePace(ended, WINDOW_MS.fiveHour, NOW).reached, false);
  assert.deepEqual(bindingLimit(reading, NOW), { label: 'Weekly', window: weekly });
  const waiting = usageAlerts(before, { claude: reading }, NOW);
  assert.equal(waiting.alerts.length, 0);
  const confirmed = usageAlerts(
    waiting.state,
    { claude: usage({ percent: 2, resetsAt: NOW + 5 * HOUR }, weekly) },
    NOW,
  );
  assert.deepEqual(
    confirmed.alerts.map((alert) => alert.title),
    ['Claude 5-hour limit reset'],
  );
});

test('Usage alerts follow custom thresholds', () => {
  const reset = NOW + HOUR;
  const thresholds = { warning: 50, critical: 85 };
  let result = usageAlerts(
    {},
    { claude: usage({ percent: 40, resetsAt: reset }, null) },
    NOW,
    thresholds,
  );
  assert.equal(result.alerts.length, 0);
  result = usageAlerts(
    result.state,
    { claude: usage({ percent: 55, resetsAt: reset }, null) },
    NOW,
    thresholds,
  );
  assert.deepEqual(
    result.alerts.map((alert) => alert.title),
    ['Claude 5-hour usage at 55%'],
  );
  result = usageAlerts(
    result.state,
    { claude: usage({ percent: 80, resetsAt: reset }, null) },
    NOW,
    thresholds,
  );
  assert.equal(result.alerts.length, 0);
  result = usageAlerts(
    result.state,
    { claude: usage({ percent: 86, resetsAt: reset }, null) },
    NOW,
    thresholds,
  );
  assert.deepEqual(
    result.alerts.map((alert) => alert.title),
    ['Claude 5-hour usage at 86%'],
  );
});

test('Alerts are independent for accounts with identical reset times', () => {
  const reading = usage({ percent: 92, resetsAt: NOW + HOUR }, null, { accountKey: 'account-a' });
  const first = usageAlerts({}, { claude: reading }, NOW);
  assert.equal(first.alerts.length, 1);
  const second = usageAlerts(first.state, { claude: { ...reading, accountKey: 'account-b' } }, NOW);
  assert.equal(second.alerts.length, 1);
  assert.equal(usageAlerts(second.state, { claude: reading }, NOW).alerts.length, 0);
});

test('Nonstandard windows use the provider duration for pace calculations', () => {
  const reading = usage(null, null, {
    extras: [
      {
        id: 'daily',
        label: '1-day',
        window: { percent: 40, resetsAt: NOW + 12 * HOUR, durationMs: 24 * HOUR },
      },
    ],
  });
  const [window] = require('../src/usageModel.ts').usageWindows(reading);
  assert.equal(window.lengthMs, 24 * HOUR);
  assert.equal(usagePace(window.window, window.lengthMs, NOW).elapsed, 0.5);
});

test('Chat usage ring shows the fullest live limit and labels the session window', () => {
  const summary = require('../src/usageModel.ts').chatUsageSummary(
    usage({ percent: 6, resetsAt: NOW + 3 * HOUR }, { percent: 91.4, resetsAt: NOW + 90 * HOUR }),
    NOW,
  );
  assert.equal(summary.ringPercent, 91);
  assert.equal(summary.tone, 'critical');
  assert.deepEqual(
    summary.rows.map((row) => [row.label, row.percent, row.reset]),
    [
      ['Session limit', 6, 'Resets in 3h 0m'],
      ['Weekly', 91, summary.rows[1].reset],
    ],
  );
});

test('Chat usage never draws a stale or unconfirmed reading as the current level', () => {
  const { chatUsageSummary } = require('../src/usageModel.ts');
  const stale = chatUsageSummary(
    usage({ percent: 80, resetsAt: NOW + HOUR }, null, { status: 'stale' }),
    NOW,
  );
  assert.equal(stale.ringPercent, null);
  assert.equal(stale.current, false);
  assert.equal(stale.rows[0].percent, 80, 'the last known figure is still listed');

  const ended = chatUsageSummary(usage({ percent: 95, resetsAt: NOW - HOUR }, null), NOW);
  assert.equal(ended.ringPercent, null, 'a window that reset has no confirmed level');
  assert.equal(ended.rows[0].pending, true);
  assert.equal(ended.rows[0].reset, 'Reset passed · awaiting update');
});

test('Chat usage handles a missing reading and per-model limits', () => {
  const { chatUsageSummary } = require('../src/usageModel.ts');
  const none = chatUsageSummary(undefined, NOW);
  assert.deepEqual([none.rows, none.ringPercent, none.current], [[], null, false]);

  const extra = chatUsageSummary(
    usage({ percent: 10, resetsAt: NOW + HOUR }, null, {
      extras: [{ id: 'opus', label: 'Opus weekly', window: { percent: 120, resetsAt: NOW + 5 * HOUR } }],
    }),
    NOW,
  );
  assert.equal(extra.rows[1].label, 'Opus weekly');
  assert.equal(extra.rows[1].percent, 100, 'percent is clamped to 100');
  assert.equal(extra.ringPercent, 100);
});
