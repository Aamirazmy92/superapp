import type { PlanUsage, UsageProvider, UsageWindow } from './types';

export const WINDOW_MS = { fiveHour: 5 * 3_600_000, weekly: 7 * 86_400_000 };
export const providerLabels: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex' };
// Below these, a projection is mostly noise from the first few replies.
const MIN_ELAPSED_TO_PROJECT = 0.1;
const MIN_PERCENT_TO_PROJECT = 5;
// Reset times drift slightly between readings; a jump past this is a new window.
const SAME_WINDOW_MS = 30 * 60_000;

export function duration(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function resetCopy(window: UsageWindow, now: number) {
  if (resetPending(window, now)) return 'Reset passed · awaiting update';
  if (!window.resetsAt) return window.percent === 0 ? 'Not started' : '';
  if (window.resetsAt - now < 86_400_000) return `Resets in ${duration(window.resetsAt - now)}`;
  return `Resets ${new Date(window.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

export function resetPending(window: UsageWindow, now: number) {
  return !!window.resetPending || (window.resetsAt !== null && window.resetsAt <= now);
}

/**
 * How far through its window a limit is, and when it runs out if use continues
 * at the average rate so far. runsOutAt is null when it would last until reset.
 */
export function usagePace(window: UsageWindow, lengthMs: number, now: number) {
  if (resetPending(window, now)) return { elapsed: null, runsOutAt: null, reached: false };
  const reached = window.percent >= 100;
  if (!window.resetsAt || window.resetsAt <= now)
    return { elapsed: null, runsOutAt: null, reached };
  const elapsed = Math.min(1, Math.max(0, 1 - (window.resetsAt - now) / lengthMs));
  let runsOutAt: number | null = null;
  if (!reached && elapsed >= MIN_ELAPSED_TO_PROJECT && window.percent >= MIN_PERCENT_TO_PROJECT) {
    const perMs = window.percent / (elapsed * lengthMs);
    const at = now + (100 - window.percent) / perMs;
    if (at < window.resetsAt) runsOutAt = at;
  }
  return { elapsed, runsOutAt, reached };
}

export function usageWindows(usage: PlanUsage) {
  return [
    { id: 'fiveHour', label: '5-hour', window: usage.fiveHour, lengthMs: WINDOW_MS.fiveHour },
    { id: 'weekly', label: 'Weekly', window: usage.weekly, lengthMs: WINDOW_MS.weekly },
    ...(usage.extras || []).map((extra) => ({
      id: extra.id,
      label: extra.label,
      window: extra.window,
      lengthMs: extra.window.durationMs || WINDOW_MS.weekly,
    })),
  ].flatMap((item) => (item.window ? [{ ...item, window: item.window }] : []));
}

/** The fullest limit: the one that stops you first. */
export function bindingLimit(usage: PlanUsage, now?: number) {
  let best: { label: string; window: UsageWindow } | null = null;
  for (const { label, window } of usageWindows(usage)) {
    if (window.resetPending || (now !== undefined && resetPending(window, now))) continue;
    if (!best || window.percent > best.window.percent) best = { label, window };
  }
  return best;
}

export function usageTone(percent: number) {
  return percent >= 90 ? 'critical' : percent >= 75 ? 'high' : 'normal';
}

export function updatedCopy(usage: PlanUsage, now: number) {
  if (!usage.updatedAt) return '';
  const age = Math.max(0, now - usage.updatedAt);
  const when = age < 60_000 ? 'just now' : `${duration(age)} ago`;
  return usage.source === 'session-log'
    ? `From last Codex reply, ${when}`
    : `${usage.status === 'ok' ? 'Updated' : 'Last known reading'} ${when}`;
}

export type ChatUsageRow = {
  id: string;
  label: string;
  percent: number;
  reset: string;
  pending: boolean;
  tone: ReturnType<typeof usageTone>;
};

/**
 * What the chat usage ring and popover show for one provider. The ring only
 * carries a figure when the reading is live and confirmed: a stale reading, or
 * a window whose reset has passed, is listed in the popover but never drawn as
 * the current level.
 */
export function chatUsageSummary(usage: PlanUsage | undefined, now: number) {
  const rows: ChatUsageRow[] = usage
    ? usageWindows(usage).map(({ id, label, window }) => ({
        id,
        label: id === 'fiveHour' ? 'Session limit' : label,
        percent: Math.min(100, Math.max(0, Math.round(window.percent))),
        reset: resetCopy(window, now),
        pending: resetPending(window, now),
        tone: usageTone(window.percent),
      }))
    : [];
  const current = usage?.status === 'ok';
  const binding = usage && current ? bindingLimit(usage, now) : null;
  const ringPercent = binding ? Math.min(100, Math.max(0, Math.round(binding.window.percent))) : null;
  return {
    rows,
    current,
    ringPercent,
    tone: ringPercent === null ? ('normal' as const) : usageTone(ringPercent),
  };
}

export type UsageAlertState = Record<string, { resetsAt: number | null; level: number }>;
export type UsageAlert = { id: string; title: string; detail: string; success: boolean };

export type UsageThresholds = { warning: number; critical: number };
const defaultThresholds: UsageThresholds = { warning: 75, critical: 90 };

function alertLevel(percent: number, { warning, critical }: UsageThresholds) {
  return percent >= 100 ? 100 : percent >= critical ? critical : percent >= warning ? warning : 0;
}

/** Warnings at each threshold and the limit, once each per window, and a note when a warned window resets. */
export function usageAlerts(
  previous: UsageAlertState,
  readings: Partial<Record<UsageProvider, PlanUsage>>,
  now: number,
  thresholds = defaultThresholds,
) {
  const state: UsageAlertState = { ...previous };
  const alerts: UsageAlert[] = [];
  for (const usage of Object.values(readings)) {
    if (!usage || usage.status !== 'ok') continue;
    const name = providerLabels[usage.provider];
    for (const { id, label, window } of usageWindows(usage)) {
      // The clock passing a reset cannot confirm the new window's usage.
      if (resetPending(window, now)) continue;
      const key = `${usage.provider}:${usage.accountKey ? `${usage.accountKey}:` : ''}${id}`;
      const phrase = id === 'weekly' ? 'weekly' : label;
      const before = state[key];
      const level = alertLevel(window.percent, thresholds);
      const newWindow =
        !!before &&
        ((before.resetsAt !== null && before.resetsAt <= now) ||
          (before.resetsAt !== null &&
            window.resetsAt !== null &&
            window.resetsAt - before.resetsAt > SAME_WINDOW_MS));
      if (newWindow && before.level > 0)
        alerts.push({
          id: `${key}:reset:${now}`,
          title: `${name} ${phrase} limit reset`,
          detail: `${label} usage is at ${Math.round(window.percent)}% again.`,
          success: true,
        });
      const shownLevel = before && !newWindow ? before.level : 0;
      if (level > shownLevel) {
        const reset = resetCopy(window, now);
        alerts.push({
          id: `${key}:${level}:${now}`,
          title:
            level === 100
              ? `${name} ${phrase} limit reached`
              : `${name} ${phrase} usage at ${Math.round(window.percent)}%`,
          detail: reset || `${label} limit`,
          success: false,
        });
      }
      state[key] = { resetsAt: window.resetsAt, level: Math.max(level, shownLevel) };
    }
  }
  return { state, alerts };
}
