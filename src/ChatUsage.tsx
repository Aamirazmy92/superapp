import { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { AnchoredPopover } from './AnchoredPopover';
import { RefreshCw } from './icons';
import type { PlanUsage, UsageProvider } from './types';
import { chatUsageSummary, duration, providerLabels, updatedCopy } from './usageModel';

const RING_RADIUS = 6.5;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const statusNotes: Partial<Record<PlanUsage['status'], string>> = {
  stale: 'Showing the last known reading.',
  'signed-out': 'Sign in to see plan usage.',
  expired: 'Sign-in expired. Sign in again to see plan usage.',
  error: 'Usage is unavailable right now.',
  unsupported: 'Plan limits do not apply to this sign-in.',
};

/**
 * Plan usage for the provider of the current chat: a ring in the composer
 * that opens the limits and when they reset. It reads the same shared
 * readings as the dashboard, so the two always agree.
 */
export default function ChatUsage({
  provider,
  usage,
  loaded,
  loading,
  error,
  onRefresh,
}: {
  provider: UsageProvider;
  /** Every provider's reading; null until the first one arrives. */
  usage: Partial<Record<UsageProvider, PlanUsage>> | null;
  loaded: boolean;
  loading: boolean;
  error?: string | null;
  onRefresh(): void;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const trigger = useRef<HTMLButtonElement>(null);
  const reading = usage?.[provider];
  const name = providerLabels[provider];
  const summary = chatUsageSummary(reading, now);
  const { ringPercent } = summary;

  // Reset countdowns stay honest while the popover is open or the ring is shown.
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), open ? 15_000 : 60_000);
    return () => clearInterval(timer);
  }, [open, reading]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (trigger.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.chat-usage-pop')) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
    };
  }, [open]);

  const label =
    ringPercent === null
      ? `${name} plan usage`
      : `${name} plan usage, ${ringPercent}% used`;
  const refreshWait = reading?.refreshAt && reading.refreshAt > now ? reading.refreshAt - now : 0;
  const allPending = summary.rows.length > 0 && summary.rows.every((row) => row.pending);
  const note = !loaded
    ? 'Checking sign-in and plan usage…'
    : !reading
      ? error || 'No usage reading available.'
      : reading.status === 'ok' && summary.rows.length === 0
        ? 'No usage limits reported for this plan.'
        : reading.message && reading.status !== 'ok'
          ? reading.message
          : statusNotes[reading.status] || '';

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        className={`chat-usage-trigger tone-${summary.tone} ${summary.current ? '' : 'inactive'} ${open ? 'open' : ''}`}
        onClick={() => setOpen((value) => !value)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle className="chat-usage-ring-track" cx="8" cy="8" r={RING_RADIUS} />
          {ringPercent !== null && ringPercent > 0 && (
            <circle
              className="chat-usage-ring-fill"
              cx="8"
              cy="8"
              r={RING_RADIUS}
              strokeDasharray={`${(ringPercent / 100) * RING_LENGTH} ${RING_LENGTH}`}
              transform="rotate(-90 8 8)"
            />
          )}
        </svg>
      </button>
      <AnimatePresence>
        {open && (
          <AnchoredPopover anchor={trigger.current} className="chat-usage-pop" role="dialog" label={`${name} usage`}>
            <div className="chat-usage-body">
              <div className="chat-usage-head">
                <strong>Usage</strong>
                {reading?.plan && <span className="chat-usage-plan">{reading.plan}</span>}
                <button
                  type="button"
                  className={`chat-usage-refresh${loading ? ' loading' : ''}`}
                  aria-label="Refresh usage"
                  title={refreshWait ? `Refresh available in ${duration(refreshWait)}` : 'Refresh usage'}
                  disabled={loading || refreshWait > 0}
                  aria-busy={loading}
                  onClick={onRefresh}
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              {summary.rows.map((row) => (
                <div key={row.id} className={`chat-usage-row ${row.pending ? 'pending' : `tone-${row.tone}`}`}>
                  <div className="chat-usage-line">
                    <span>{row.label}</span>
                    <span className="chat-usage-percent">{row.pending ? '—' : `${row.percent}% used`}</span>
                  </div>
                  <span
                    className="chat-usage-bar"
                    role={row.pending ? undefined : 'meter'}
                    aria-label={`${row.label} used`}
                    aria-valuemin={row.pending ? undefined : 0}
                    aria-valuemax={row.pending ? undefined : 100}
                    aria-valuenow={row.pending ? undefined : row.percent}
                    aria-valuetext={
                      row.pending
                        ? undefined
                        : `${row.percent}% used${summary.current ? '' : ', last known reading'}`
                    }
                  >
                    <span style={{ width: `${row.pending ? 0 : row.percent}%` }} />
                  </span>
                  {row.reset && <small className="chat-usage-reset">{row.reset}</small>}
                </div>
              ))}
              {reading && summary.rows.length > 0 && (
                <small className="chat-usage-updated">
                  {allPending ? 'Waiting for a new reading.' : updatedCopy(reading, now)}
                </small>
              )}
              {note && (
                <p className={`chat-usage-note${summary.current ? '' : ' warn'}`} role="status">
                  {note}
                </p>
              )}
              {error && loaded && <p className="chat-usage-note warn" role="status">{error}</p>}
            </div>
          </AnchoredPopover>
        )}
      </AnimatePresence>
    </>
  );
}
