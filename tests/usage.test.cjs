const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  parseClaudeUsage,
  parseCodexUsage,
  parseCodexSnapshot,
  latestCodexSnapshot,
  readClaudeUsage,
  readCodexUsage,
  createUsageService,
} = require('../electron/usage.cjs');

const NOW = Date.parse('2026-09-30T20:00:00Z');
const HOUR = 3_600_000;

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo usage '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}
const claudeBody = {
  five_hour: { utilization: 12.0, resets_at: '2026-09-30T22:50:00.395425+00:00' },
  seven_day: { utilization: 26.0, resets_at: '2026-10-03T04:00:00.395446+00:00' },
  seven_day_opus: null,
};
const codexBody = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 3, limit_window_seconds: 18000, reset_at: 1790820038 },
    secondary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1791052582 },
  },
};
async function writeClaudeCredentials(dir, oauth) {
  await fs.writeFile(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
}
async function writeCodexAuth(dir, auth) {
  await fs.writeFile(path.join(dir, 'auth.json'), JSON.stringify(auth));
}
function snapshotLine(timestamp, primary, secondary, accountId, userId) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary,
        secondary,
        plan_type: 'plus',
        ...(accountId && { account_id: accountId }),
        ...(userId && { user_id: userId }),
      },
    },
  });
}
async function writeRollout(dir, day, name, lines, mtime) {
  const folder = path.join(dir, 'sessions', ...day.split('/'));
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, name);
  await fs.writeFile(file, lines.join('\n') + '\n');
  if (mtime) await fs.utimes(file, mtime / 1000, mtime / 1000);
  return file;
}

test('Claude usage maps the five-hour and seven-day windows', () => {
  assert.deepEqual(parseClaudeUsage(claudeBody), {
    fiveHour: { percent: 12, resetsAt: Date.parse('2026-09-30T22:50:00.395Z') },
    weekly: { percent: 26, resetsAt: Date.parse('2026-10-03T04:00:00.395Z') },
  });
  assert.deepEqual(parseClaudeUsage({ five_hour: null, seven_day: { utilization: 150 } }), {
    fiveHour: null,
    weekly: { percent: 100, resetsAt: null },
  });
});

test('Codex windows are identified by their length, not their position', () => {
  assert.deepEqual(parseCodexUsage(codexBody), {
    plan: 'plus',
    fiveHour: { percent: 3, resetsAt: 1790820038_000 },
    weekly: { percent: 7, resetsAt: 1791052582_000 },
  });
  const weeklyOnly = parseCodexUsage({
    plan_type: 'free',
    rate_limit: {
      primary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1791052582 },
    },
  });
  assert.equal(weeklyOnly.fiveHour, null);
  assert.equal(weeklyOnly.weekly.percent, 40);
});

test('An unused Codex window that has not started has no reset time', () => {
  const parsed = parseCodexUsage({
    rate_limit: {
      primary_window: {
        used_percent: 0,
        limit_window_seconds: 18000,
        reset_after_seconds: 18000,
        reset_at: 1790820038,
      },
      secondary_window: {
        used_percent: 0,
        limit_window_seconds: 604800,
        reset_after_seconds: 250544,
        reset_at: 1791052582,
      },
    },
  });
  assert.deepEqual(parsed.fiveHour, { percent: 0, resetsAt: null });
  assert.deepEqual(parsed.weekly, { percent: 0, resetsAt: 1791052582_000 });
});

test('A session-log snapshot whose window has passed awaits a confirmed reading', () => {
  const parsed = parseCodexSnapshot(
    {
      plan_type: 'plus',
      primary: { used_percent: 80, window_minutes: 300, resets_at: (NOW - HOUR) / 1000 },
      secondary: { used_percent: 30, window_minutes: 10080, resets_at: (NOW + 48 * HOUR) / 1000 },
    },
    NOW,
  );
  assert.deepEqual(parsed.fiveHour, { percent: 80, resetsAt: NOW - HOUR, resetPending: true });
  assert.deepEqual(parsed.weekly, { percent: 30, resetsAt: NOW + 48 * HOUR });
});

test('The newest Codex rate-limit snapshot is found across session logs', async (t) => {
  const dir = await tempDir(t);
  const primary = (used) => ({
    used_percent: used,
    window_minutes: 300,
    resets_at: (NOW + HOUR) / 1000,
  });
  const secondary = { used_percent: 9, window_minutes: 10080, resets_at: (NOW + 72 * HOUR) / 1000 };
  await writeRollout(
    dir,
    '2026/09/29',
    'rollout-old.jsonl',
    [snapshotLine('2026-09-29T10:00:00Z', primary(50), secondary)],
    NOW - 30 * HOUR,
  );
  await writeRollout(
    dir,
    '2026/09/30',
    'rollout-a.jsonl',
    [
      snapshotLine('2026-09-30T18:00:00Z', primary(20), secondary),
      snapshotLine('2026-09-30T19:00:00Z', primary(21), secondary),
      '{"timestamp":"2026-09-30T19:01:00Z","type":"event_msg","payload":{"type":"agent_message"}}',
      '{not json',
    ],
    NOW - 2 * HOUR,
  );
  await writeRollout(
    dir,
    '2026/09/30',
    'rollout-b.jsonl',
    [snapshotLine('2026-09-30T19:30:00Z', primary(24), secondary)],
    NOW - 3 * HOUR,
  );
  const found = await latestCodexSnapshot(dir, NOW);
  assert.equal(found.fiveHour.percent, 24);
  assert.equal(found.weekly.percent, 9);
  assert.equal(found.observedAt, Date.parse('2026-09-30T19:30:00Z'));
  assert.equal(await latestCodexSnapshot(path.join(dir, 'missing'), NOW), null);
});

test('Claude usage is read live with the saved sign-in and never refreshes it', async (t) => {
  const dir = await tempDir(t);
  await writeClaudeCredentials(dir, {
    accessToken: 'claude-token',
    expiresAt: NOW + HOUR,
    subscriptionType: 'pro',
  });
  const calls = [];
  const result = await readClaudeUsage({
    configDir: dir,
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response(200, claudeBody);
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer claude-token');
  assert.equal(calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(result.status, 'ok');
  assert.equal(result.plan, 'pro');
  assert.equal(result.source, 'live');
  assert.equal(result.updatedAt, NOW);
  assert.equal(result.fiveHour.percent, 12);
  assert.equal(result.weekly.percent, 26);
  assert.equal(JSON.stringify(result).includes('claude-token'), false);
});

test('Claude reports signed-out and expired sign-ins without calling the API', async (t) => {
  const dir = await tempDir(t);
  const fetch = async () => assert.fail('should not fetch');
  assert.equal(
    (await readClaudeUsage({ configDir: dir, now: () => NOW, fetch })).status,
    'signed-out',
  );
  await writeClaudeCredentials(dir, { accessToken: 'old', expiresAt: NOW - 1 });
  const expired = await readClaudeUsage({ configDir: dir, now: () => NOW, fetch });
  assert.equal(expired.status, 'expired');
  assert.match(expired.message, /claude/i);
});

test('Claude rejected tokens read as expired, rate limits carry a retry delay', async (t) => {
  const dir = await tempDir(t);
  await writeClaudeCredentials(dir, { accessToken: 'token', expiresAt: NOW + HOUR });
  const rejected = await readClaudeUsage({
    configDir: dir,
    now: () => NOW,
    fetch: async () => response(401, {}),
  });
  assert.equal(rejected.status, 'expired');
  const limited = await readClaudeUsage({
    configDir: dir,
    now: () => NOW,
    fetch: async () => response(429, {}, { 'retry-after': '120' }),
  });
  assert.equal(limited.status, 'error');
  assert.equal(limited.retryAfterMs, 120_000);
});

test('Codex usage is read live with the ChatGPT sign-in', async (t) => {
  const dir = await tempDir(t);
  await writeCodexAuth(dir, {
    auth_mode: 'chatgpt',
    tokens: { access_token: 'codex-token', account_id: 'acct' },
  });
  const calls = [];
  const result = await readCodexUsage({
    codexHome: dir,
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response(200, codexBody);
    },
  });
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer codex-token');
  assert.equal(calls[0].init.headers['ChatGPT-Account-Id'], 'acct');
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'live');
  assert.equal(result.plan, 'plus');
  assert.equal(result.fiveHour.percent, 3);
  assert.equal(JSON.stringify(result).includes('codex-token'), false);
});

test('Codex falls back to the newest session-log snapshot when the API fails', async (t) => {
  const dir = await tempDir(t);
  await writeCodexAuth(dir, {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'codex-token',
      account_id: 'current-account',
      id_token: `header.${Buffer.from(JSON.stringify({ sub: 'current-user' })).toString('base64url')}.signature`,
    },
  });
  await writeRollout(dir, '2026/09/30', 'rollout-a.jsonl', [
    snapshotLine(
      '2026-09-30T19:00:00Z',
      { used_percent: 15, window_minutes: 300, resets_at: (NOW + HOUR) / 1000 },
      { used_percent: 8, window_minutes: 10080, resets_at: (NOW + 72 * HOUR) / 1000 },
      'current-account',
      'current-user',
    ),
  ]);
  const result = await readCodexUsage({
    codexHome: dir,
    now: () => NOW,
    fetch: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(result.status, 'stale');
  assert.equal(result.source, 'session-log');
  assert.equal(result.updatedAt, Date.parse('2026-09-30T19:00:00Z'));
  assert.equal(result.fiveHour.percent, 15);
});

test('Codex without a ChatGPT sign-in has no plan limits to show', async (t) => {
  const dir = await tempDir(t);
  const fetch = async () => assert.fail('should not fetch');
  assert.equal(
    (await readCodexUsage({ codexHome: dir, now: () => NOW, fetch })).status,
    'signed-out',
  );
  await writeCodexAuth(dir, { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' });
  assert.equal(
    (await readCodexUsage({ codexHome: dir, now: () => NOW, fetch })).status,
    'unsupported',
  );
});

test('The usage service caches, keeps the last reading on failure, and backs off', async () => {
  let clock = NOW;
  let calls = 0;
  let next = () => ({
    provider: 'claude',
    status: 'ok',
    fiveHour: { percent: 5, resetsAt: null },
    weekly: null,
    updatedAt: clock,
  });
  const service = createUsageService({
    now: () => clock,
    readers: { claude: async () => (calls++, next()) },
  });
  const first = await service.get();
  assert.equal(first.claude.fiveHour.percent, 5);
  await service.get();
  assert.equal(calls, 1, 'a second read inside the cache window is served from cache');

  clock += 61_000;
  next = () => ({
    provider: 'claude',
    status: 'error',
    message: 'Too many requests',
    retryAfterMs: 120_000,
  });
  const failed = await service.get();
  assert.equal(calls, 2);
  assert.equal(failed.claude.status, 'stale', 'the last good reading is kept');
  assert.equal(failed.claude.fiveHour.percent, 5);
  assert.equal(failed.claude.message, 'Too many requests');
  assert.equal(failed.claude.retryAt, clock + 120_000, 'the card can say when it tries again');

  clock += 60_000;
  await service.get({ force: true });
  assert.equal(calls, 2, 'forced reads still wait out the retry delay');

  clock += 61_000;
  next = () => ({
    provider: 'claude',
    status: 'ok',
    fiveHour: { percent: 9, resetsAt: null },
    weekly: null,
    updatedAt: clock,
  });
  const recovered = await service.get();
  assert.equal(recovered.claude.fiveHour.percent, 9);
  assert.equal(recovered.claude.retryAt, undefined);
  assert.equal(calls, 3);
});

test('Repeated rate limits back off further each time, up to half an hour', async () => {
  let clock = NOW;
  let calls = 0;
  let limited = true;
  const service = createUsageService({
    now: () => clock,
    readers: {
      claude: async () => (
        calls++,
        limited
          ? { provider: 'claude', status: 'error', message: 'Slow down', retryAfterMs: 5 * 60_000 }
          : {
              provider: 'claude',
              status: 'ok',
              fiveHour: { percent: 1, resetsAt: null },
              weekly: null,
              updatedAt: clock,
            }
      ),
    },
  });
  const delays = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const { claude } = await service.get({ force: true });
    delays.push((claude.retryAt - clock) / 60_000);
    clock = claude.retryAt;
  }
  assert.deepEqual(delays, [5, 10, 20, 30, 30]);
  assert.equal(calls, 5);
  limited = false;
  await service.get({ force: true });
  limited = true;
  clock += 60_000;
  const { claude } = await service.get();
  assert.equal((claude.retryAt - clock) / 60_000, 5, 'a success resets the back-off');
});

test('Forced refreshes are allowed sooner than the cache window but not instantly', async () => {
  let clock = NOW;
  let calls = 0;
  const service = createUsageService({
    now: () => clock,
    readers: {
      codex: async () => (calls++, { provider: 'codex', status: 'ok', updatedAt: clock }),
    },
  });
  await Promise.all([service.get(), service.get()]);
  assert.equal(calls, 1, 'concurrent reads share one request');
  clock += 20_000;
  await service.get({ force: true });
  assert.equal(calls, 1);
  clock += 10_000;
  await service.get({ force: true });
  assert.equal(calls, 2);
});

test('A usage reply in an unrecognised format is reported, not shown as empty', async (t) => {
  const dir = await tempDir(t);
  await writeClaudeCredentials(dir, { accessToken: 'token', expiresAt: NOW + HOUR });
  const claude = await readClaudeUsage({
    configDir: dir,
    now: () => NOW,
    fetch: async () => response(200, { session: {} }),
  });
  assert.equal(claude.status, 'error');
  assert.match(claude.message, /format/i);
  await writeCodexAuth(dir, { auth_mode: 'chatgpt', tokens: { access_token: 'token' } });
  const codex = await readCodexUsage({
    codexHome: dir,
    now: () => NOW,
    fetch: async () => response(200, { rate_limit: {} }),
  });
  assert.equal(codex.status, 'error');
  assert.match(codex.message, /format/i);
});

test('Claude model-specific weekly limits are included when the plan has them', () => {
  const parsed = parseClaudeUsage({
    ...claudeBody,
    seven_day_opus: { utilization: 61, resets_at: '2026-10-03T04:00:00Z' },
    seven_day_sonnet: null,
  });
  assert.deepEqual(parsed.extras, [
    {
      id: 'opus',
      label: 'Opus weekly',
      window: { percent: 61, resetsAt: Date.parse('2026-10-03T04:00:00Z') },
    },
  ]);
  assert.equal(parseClaudeUsage(claudeBody).extras, undefined);
});

test('Readings whose window has ended await an update instead of claiming zero usage', async () => {
  let clock = NOW;
  const service = createUsageService({
    now: () => clock,
    readers: {
      claude: async () => ({
        provider: 'claude',
        status: 'ok',
        fiveHour: { percent: 80, resetsAt: NOW + 1000 },
        weekly: { percent: 30, resetsAt: NOW + 72 * HOUR },
        updatedAt: clock,
      }),
    },
  });
  await service.get();
  clock += 2000;
  const { claude } = await service.peek();
  assert.deepEqual(claude.fiveHour, { percent: 80, resetsAt: NOW + 1000, resetPending: true });
  assert.equal(claude.weekly.percent, 30);
});

test('The last readings are restored at start and saved after each change', async () => {
  const saved = [];
  let resolveRead;
  const service = createUsageService({
    now: () => NOW,
    load: async () => ({
      codex: {
        provider: 'codex',
        status: 'ok',
        plan: 'plus',
        fiveHour: { percent: 12, resetsAt: NOW + HOUR },
        weekly: null,
        updatedAt: NOW - HOUR,
      },
      bogus: { provider: 'bogus' },
    }),
    save: async (value) => saved.push(value),
    readers: { codex: () => new Promise((resolve) => (resolveRead = resolve)) },
  });
  const restored = await service.peek();
  assert.equal(restored.codex.status, 'stale', 'a restored reading is marked as not current');
  assert.equal(restored.codex.fiveHour.percent, 12);
  assert.equal('bogus' in restored, false);
  const pending = service.get();
  await new Promise((resolve) => setImmediate(resolve));
  resolveRead({
    provider: 'codex',
    status: 'ok',
    fiveHour: { percent: 14, resetsAt: NOW + HOUR },
    weekly: null,
    updatedAt: NOW,
  });
  assert.equal((await pending).codex.fiveHour.percent, 14);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].codex.fiveHour.percent, 14);
});

test('Usage endpoints can be redirected only to a loopback test server', async (t) => {
  const dir = await tempDir(t);
  await writeClaudeCredentials(dir, { accessToken: 'token', expiresAt: NOW + HOUR });
  const urls = [];
  const fetch = async (url) => (urls.push(url), response(200, claudeBody));
  await readClaudeUsage({
    configDir: dir,
    now: () => NOW,
    fetch,
    testOrigin: 'http://127.0.0.1:4567',
  });
  await readClaudeUsage({
    configDir: dir,
    now: () => NOW,
    fetch,
    testOrigin: 'https://example.com',
  });
  await readClaudeUsage({
    configDir: dir,
    now: () => NOW,
    fetch,
    testOrigin: 'http://127.0.0.1:4567/path',
  });
  assert.deepEqual(urls, [
    'http://127.0.0.1:4567/api/oauth/usage',
    'https://api.anthropic.com/api/oauth/usage',
    'https://api.anthropic.com/api/oauth/usage',
  ]);
});

test('Malformed percentages and window lengths are rejected instead of becoming zero usage', () => {
  for (const value of [null, undefined, '', ' ', false, true, {}, [], 'unknown']) {
    assert.equal(parseClaudeUsage({ five_hour: { utilization: value } }).fiveHour, null);
    assert.equal(
      parseCodexUsage({
        rate_limit: { primary_window: { used_percent: value, limit_window_seconds: 18000 } },
      }).fiveHour,
      null,
    );
  }
  for (const seconds of [null, 0, -1, 'unknown'])
    assert.equal(
      parseCodexUsage({
        rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: seconds } },
      }).fiveHour,
      null,
    );
  assert.equal(parseClaudeUsage({ five_hour: { utilization: '0' } }).fiveHour.percent, 0);
});

test('Malformed newer log entries do not hide the last usable Codex snapshot', async (t) => {
  const dir = await tempDir(t);
  await writeRollout(dir, '2026/09/30', 'rollout-a.jsonl', [
    snapshotLine(
      '2026-09-30T19:00:00Z',
      { used_percent: 25, window_minutes: 300, resets_at: (NOW + HOUR) / 1000 },
      null,
    ),
    snapshotLine('2026-09-30T19:30:00Z', { used_percent: null, window_minutes: 300 }, null),
  ]);
  assert.equal((await latestCodexSnapshot(dir, NOW)).fiveHour.percent, 25);
});

test('Retry-After HTTP dates and long provider cooldowns are respected', async (t) => {
  const dir = await tempDir(t);
  await writeClaudeCredentials(dir, { accessToken: 'token', expiresAt: NOW + HOUR });
  const result = await readClaudeUsage({
    configDir: dir,
    now: () => NOW,
    fetch: async () => response(429, {}, { 'retry-after': new Date(NOW + HOUR).toUTCString() }),
  });
  assert.equal(result.retryAfterMs, HOUR);
  let clock = NOW;
  let calls = 0;
  const service = createUsageService({
    now: () => clock,
    readers: { claude: async () => (calls++, result) },
  });
  assert.equal((await service.get()).claude.retryAt, NOW + HOUR);
  clock += 31 * 60_000;
  await service.get({ force: true });
  assert.equal(calls, 1);
});

test('Parallel provider replies serialize cache saves and preserve both readings', async () => {
  let writing = false;
  let saved;
  const service = createUsageService({
    now: () => NOW,
    readers: Object.fromEntries(
      ['claude', 'codex'].map((provider) => [
        provider,
        async () => ({
          provider,
          status: 'ok',
          fiveHour: { percent: 20, resetsAt: NOW + HOUR },
          updatedAt: NOW,
        }),
      ]),
    ),
    save: async (value) => {
      assert.equal(writing, false, 'atomic writes must never overlap');
      writing = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      saved = value;
      writing = false;
    },
  });
  await service.get();
  assert.deepEqual(Object.keys(saved).sort(), ['claude', 'codex']);
});

test('An older Codex fallback cannot replace a newer live reading', async () => {
  let clock = NOW;
  let fallback = false;
  const service = createUsageService({
    now: () => clock,
    readers: {
      codex: async () => ({
        provider: 'codex',
        status: fallback ? 'stale' : 'ok',
        source: fallback ? 'session-log' : 'live',
        updatedAt: fallback ? NOW - HOUR : NOW,
        fiveHour: { percent: fallback ? 5 : 40, resetsAt: NOW + HOUR },
        message: fallback ? 'Offline' : undefined,
      }),
    },
  });
  await service.get();
  clock += 61_000;
  fallback = true;
  const { codex } = await service.get();
  assert.equal(codex.fiveHour.percent, 40);
  assert.equal(codex.status, 'stale');
  assert.equal(codex.message, 'Offline');
  assert.equal(codex.source, 'live');
});

test('Signing out clears saved readings so they cannot reappear after a restart', async () => {
  let clock = NOW;
  let signedOut = false;
  let saved;
  const service = createUsageService({
    now: () => clock,
    save: async (value) => {
      saved = value;
    },
    readers: {
      claude: async () =>
        signedOut
          ? { provider: 'claude', status: 'signed-out' }
          : {
              provider: 'claude',
              status: 'ok',
              fiveHour: { percent: 20, resetsAt: NOW + HOUR },
              updatedAt: NOW,
            },
    },
  });
  await service.get();
  signedOut = true;
  clock += 61_000;
  assert.equal((await service.get()).claude.status, 'signed-out');
  assert.deepEqual(saved, {});
});

test('Invalid saved readings are sanitized independently for each provider', async () => {
  const service = createUsageService({
    now: () => NOW,
    readers: { claude: async () => {}, codex: async () => {} },
    load: async () => ({
      claude: { provider: 'claude', fiveHour: { percent: null } },
      codex: {
        provider: 'codex',
        fiveHour: { percent: 20, resetsAt: 'broken' },
        extras: {},
        accessToken: 'secret',
      },
    }),
  });
  const cached = await service.peek();
  assert.equal(cached.claude, undefined);
  assert.deepEqual(cached.codex.fiveHour, { percent: 20, resetsAt: null });
  assert.equal(cached.codex.status, 'stale');
  assert.equal(JSON.stringify(cached).includes('secret'), false);
});

test('A passed reset bypasses the normal cache window but preserves request throttling', async () => {
  let clock = NOW;
  let calls = 0;
  const service = createUsageService({
    now: () => clock,
    readers: {
      claude: async () => ({
        provider: 'claude',
        status: 'ok',
        fiveHour: {
          percent: ++calls === 1 ? 90 : 2,
          resetsAt: calls === 1 ? NOW + 10_000 : NOW + HOUR,
        },
        updatedAt: clock,
      }),
    },
  });
  const initial = await service.get();
  assert.equal(initial.claude.refreshAt, NOW + 30_000);
  clock += 11_000;
  assert.equal((await service.get()).claude.fiveHour.resetPending, true);
  assert.equal(calls, 1);
  clock += 20_000;
  assert.equal((await service.get()).claude.fiveHour.percent, 2);
  assert.equal(calls, 2);
});
