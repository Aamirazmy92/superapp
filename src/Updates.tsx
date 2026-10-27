import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from './icons';
import type { UpdateState } from './types';
import './updates.css';

/** The updater's current state, kept in step with the main process. null until it answers. */
export function useUpdateState() {
  const [update, setUpdate] = useState<UpdateState | null>(null);
  useEffect(() => {
    const api = window.workspace;
    if (!api) return;
    void api.updateState().then(setUpdate, () => {});
    return api.onUpdateState(setUpdate);
  }, []);
  return update;
}

export function updateSummary(u: UpdateState) {
  if (!u.supported) return 'Updates install in the packaged app. This copy is running from source.';
  switch (u.status) {
    case 'checking': return 'Checking for updates…';
    case 'downloading': return `Downloading Veyo ${u.latest ?? ''}… ${u.percent ?? 0}%`.replace('  ', ' ');
    case 'ready': return `Veyo ${u.latest} is ready to install.`;
    case 'current': return 'You are on the latest version.';
    case 'error': return `Could not check for updates: ${u.error ?? 'unknown error'}`;
    default: return 'Veyo checks for updates automatically.';
  }
}

export function checkedAgo(at?: number) {
  if (!at) return 'Not checked yet';
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return 'Checked just now';
  if (minutes < 60) return `Checked ${minutes} min ago`;
  return `Checked at ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * Title bar button that appears once a newer release is being downloaded or is ready. Clicking a
 * ready update asks before restarting, so nothing closes unexpectedly.
 */
export function UpdateButton({ update, onInstall }: { update: UpdateState | null; onInstall(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const ready = update?.status === 'ready';
  const downloading = update?.status === 'downloading';
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  useEffect(() => {
    if (!ready) setOpen(false);
  }, [ready]);
  if (!update || (!ready && !downloading)) return null;
  const label = ready ? `Update to Veyo ${update.latest}` : `Downloading Veyo ${update.latest ?? 'update'}… ${update.percent ?? 0}%`;
  return (
    <div className="update-wrap" ref={wrap}>
      <button
        type="button"
        className={`update-button ${ready ? 'ready' : 'downloading'}`}
        aria-label={label}
        aria-haspopup={ready ? 'dialog' : undefined}
        aria-expanded={ready ? open : undefined}
        title={label}
        disabled={!ready}
        onClick={() => setOpen((value) => !value)}
      >
        {ready ? <Download size={14} aria-hidden="true" /> : <RefreshCw size={14} className="update-spin" aria-hidden="true" />}
        <span>{ready ? 'Update' : `${update.percent ?? 0}%`}</span>
      </button>
      {open && ready && (
        <div className="update-popover" role="dialog" aria-label="Install update">
          <strong>Veyo {update.latest} is ready</strong>
          <p>Veyo will save your work, restart, and open again on the new version.</p>
          <div>
            <button type="button" className="secondary-button" onClick={() => setOpen(false)}>
              Later
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              autoFocus
              onClick={async () => {
                setBusy(true);
                try {
                  await onInstall();
                } finally {
                  setBusy(false);
                  setOpen(false);
                }
              }}
            >
              Restart now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
