import type { CSSProperties } from 'react';
import { RefreshCw } from './icons';
import AgentLogo from './AgentLogo';
import type { PlanUsage, UsageProvider, UsageWindow } from './types';
import type { UsageReadings } from './useUsage';
import {
  duration,
  providerLabels,
  resetCopy,
  resetPending,
  usagePace,
  usageTone,
  usageWindows,
} from './usageModel';

const providers: UsageProvider[] = ['claude', 'codex'];

function refreshDelay(ms: number) {
  return ms < 60_000 ? `${Math.max(1, Math.ceil(ms / 1000))}s` : duration(ms);
}

function updatedCopy(usage: PlanUsage, now: number) {
  if (!usage.updatedAt) return '';
  const age = Math.max(0, now - usage.updatedAt);
  const when = age < 60_000 ? 'just now' : `${duration(age)} ago`;
  return usage.source === 'session-log'
    ? `From last Codex reply, ${when}`
    : `${usage.status === 'ok' ? 'Updated' : 'Last known reading'} ${when}`;
}

const statusLabels: Record<PlanUsage['status'], string> = {
  ok: 'Live',
  stale: 'Last known',
  'signed-out': 'Sign in',
  expired: 'Sign-in expired',
  error: 'Unavailable',
  unsupported: 'Not applicable',
};

/** Green fades to amber from 50%, then to red by 90%, so the bar warns before the limit. */
function heatColor(percent: number) {
  if (percent >= 90) return 'var(--danger)';
  if (percent >= 75)
    return `color-mix(in srgb, var(--danger) ${Math.round(((percent - 75) / 15) * 100)}%, var(--warning))`;
  if (percent > 50)
    return `color-mix(in srgb, var(--warning) ${Math.round(((percent - 50) / 25) * 100)}%, var(--running))`;
  return 'var(--running)';
}

/** Below this share of the bar the percentage no longer fits inside the fill. */
const LABEL_INSIDE_FROM = 14;

function Meter({
  label,
  window,
  lengthMs,
  now,
  current,
}: {
  label: string;
  window: UsageWindow;
  lengthMs: number;
  now: number;
  current: boolean;
}) {
  const percent = Math.round(window.percent);
  // Shown as what is left: the bar starts full and drains toward the limit.
  const remainingExact = Math.min(100, Math.max(0, 100 - window.percent));
  const remaining = Math.max(0, 100 - percent);
  const pace = usagePace(window, lengthMs, now);
  const pending = resetPending(window, now);
  const elapsed = pace.elapsed === null ? null : Math.round(pace.elapsed * 100);
  const warning =
    !current || pending
      ? ''
      : pace.reached
        ? 'Limit reached'
        : window.percent >= 90
          ? 'Almost out of usage'
          : '';
  return (
    <div
      className={`usage-meter ${pending ? 'pending' : usageTone(window.percent)}`}
      style={pending ? undefined : ({ '--tone': heatColor(window.percent) } as CSSProperties)}
    >
      <span
        className={`usage-meter-track${!pending && remainingExact < LABEL_INSIDE_FROM ? ' label-outside' : ''}`}
        role={pending ? undefined : 'meter'}
        aria-label={`${label} usage remaining`}
        aria-valuemin={pending ? undefined : 0}
        aria-valuemax={pending ? undefined : 100}
        aria-valuenow={pending ? undefined : remainingExact}
        aria-valuetext={
          pending
            ? undefined
            : `${remaining}% remaining, ${percent}% used${current ? '' : ', last known reading'}${elapsed === null ? '' : `, ${elapsed}% of the window passed`}`
        }
        title={
          elapsed === null
            ? `${percent}% used`
            : `${remaining}% left · ${elapsed}% of the window has passed`
        }
      >
        <span className="usage-meter-fill" style={{ width: `${pending ? 0 : remainingExact}%` }} />
        <strong
          className="usage-meter-value"
          aria-hidden="true"
          style={pending ? undefined : ({ '--fill': `${remainingExact}%` } as CSSProperties)}
        >
          {pending ? '—' : `${remaining}%${remainingExact >= 45 ? ' left' : ''}`}
        </strong>
      </span>
      <span className="usage-meter-label" title={`${label} usage remaining`}>{label}</span>
      <span
        className="usage-meter-reset"
        title={
          window.resetsAt
            ? new Date(window.resetsAt).toLocaleString([], {
                dateStyle: 'medium',
                timeStyle: 'short',
              })
            : undefined
        }
      >
        <span>{resetCopy(window, now)}</span>
        {warning && <em className="usage-meter-warning">{warning}</em>}
      </span>
    </div>
  );
}

export default function UsagePanel({
  usage,
  loading,
  now,
  onRefresh,
  error,
}: {
  usage: UsageReadings | null;
  loading: boolean;
  now: number;
  onRefresh: () => void;
  error?: string | null;
}) {
  const shown = providers.map(
    (provider): PlanUsage =>
      usage?.[provider] || {
        provider,
        status: error ? 'error' : 'signed-out',
        plan: null,
        fiveHour: null,
        weekly: null,
        message: error
          ? 'No usage reading available.'
          : usage === null
            ? 'Checking sign-in and plan usage…'
            : provider === 'claude'
              ? 'Sign in to Claude Code, then refresh to see plan usage.'
              : 'Sign in to Codex with ChatGPT, then refresh to see plan usage.',
      },
  );
  const refreshAt = shown.every((item) => item.refreshAt && item.refreshAt > now)
    ? Math.min(...shown.map((item) => item.refreshAt!))
    : null;
  return (
    <section className="usage-panel" aria-label="Plan usage">
      <div className="usage-panel-heading">
        <p className="usage-panel-description">Shared across all projects and agents.</p>
        <button
          className={`usage-panel-refresh${loading ? ' loading' : ''}`}
          aria-label="Refresh usage"
          title={
            refreshAt ? `Refresh available in ${refreshDelay(refreshAt - now)}` : 'Refresh usage'
          }
          disabled={loading || refreshAt !== null}
          aria-busy={loading}
          onClick={onRefresh}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {error && (
        <p className="usage-panel-error" role="status">
          {error}
        </p>
      )}
      <div className="usage-panel-cards">
        {shown.map((item) => {
          const windows = usageWindows(item);
          return (
            <article
              className={`usage-card status-${item.status}`}
              key={item.provider}
              data-provider={item.provider}
            >
              <header>
                <AgentLogo agentId={item.provider} size={16} />
                <strong>{providerLabels[item.provider]}</strong>
                {item.plan && <span className="usage-card-plan">{item.plan}</span>}
                <span className="usage-card-status">
                  {usage === null && !error
                    ? 'Checking'
                    : windows.length > 0 && windows.every(({ window }) => resetPending(window, now))
                      ? 'Awaiting update'
                      : statusLabels[item.status]}
                </span>
              </header>
              {windows.length > 0 && (
                <small className="usage-card-updated">{updatedCopy(item, now)}</small>
              )}
              {windows.map(({ id, label, window, lengthMs }) => (
                <Meter
                  key={id}
                  label={label}
                  window={window}
                  lengthMs={lengthMs}
                  now={now}
                  current={item.status === 'ok'}
                />
              ))}
              {item.message && (item.status !== 'ok' || !windows.length) && (
                <p className="usage-card-message">{item.message}</p>
              )}
              {item.retryAt && item.retryAt > now && (
                <p className="usage-card-message">
                  Next check available in {duration(item.retryAt - now)}.
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
