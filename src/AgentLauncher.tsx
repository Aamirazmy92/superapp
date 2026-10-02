import { useEffect, useRef, useState } from 'react';
import { Check, Minus, Plus, RefreshCw, X } from 'lucide-react';
import type { AgentOption, TerminalInfo } from './types';
import AgentLogo from './AgentLogo';
import { useIsPresent } from 'motion/react';
import { Backdrop, MotionDialog } from './motion';
import { getCachedPaneAgents } from './NewPaneMenu';

export default function AgentLauncher({
  projectId,
  projectName,
  workspaceName,
  shells,
  onClose,
  onLaunched,
}: {
  projectId: string;
  projectName: string;
  workspaceName: string;
  shells: { id: string; label: string }[];
  onClose(): void;
  onLaunched(terminals: TerminalInfo[]): void;
}) {
  const cached = getCachedPaneAgents(projectId, workspaceName);
  const [agents, setAgents] = useState<AgentOption[]>(
    cached?.agents.filter((agent) => agent.installed) || [],
  );
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [remaining, setRemaining] = useState(cached?.remaining ?? 0);
  const [loading, setLoading] = useState(!cached);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');
  const [shell, setShell] = useState(shells[0]?.id || '');
  const isPresent = useIsPresent();
  const dialogRef = useRef<HTMLElement>(null);
  const launchInFlight = useRef(false);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  async function refresh(silent = false, fresh = false) {
    if (!silent) setLoading(true);
    setError('');
    try {
      const result = await window.workspace!.listAgents(projectId, workspaceName, fresh);
      setAgents(result.agents.filter((agent) => agent.installed));
      setRemaining(result.remaining);
      const installed = new Set(
        result.agents.filter((agent) => agent.installed).map((agent) => agent.id),
      );
      setCounts((previous) => {
        let slots = result.remaining;
        return Object.fromEntries(
          Object.entries(previous).flatMap(([id, count]) => {
            if (!installed.has(id) || slots < 1) return [];
            const next = Math.min(count, slots);
            slots -= next;
            return next > 0 ? [[id, next]] : [];
          }),
        );
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh(!!cached);
  }, []);
  useEffect(() => {
    if (!isPresent) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!launching) onClose();
      } else if (event.key === 'Tab') {
        const controls = [
          ...(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
          ) || []),
        ];
        if (!controls.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!dialogRef.current?.contains(document.activeElement)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [isPresent, launching, onClose]);

  function changeCount(agentId: string, change: (count: number) => number) {
    if (loading || launching) return;
    setCounts((previous) => {
      const current = previous[agentId] || 0;
      const next = change(current);
      const otherTotal = Object.entries(previous).reduce(
        (sum, [id, count]) => sum + (id === agentId ? 0 : count),
        0,
      );
      if (
        !Number.isSafeInteger(next) ||
        next < 0 ||
        next > remaining - otherTotal ||
        next === current
      )
        return previous;
      const updated = { ...previous };
      if (next) updated[agentId] = next;
      else delete updated[agentId];
      return updated;
    });
  }

  async function launch() {
    if (!total || total > remaining || launching || launchInFlight.current) return;
    launchInFlight.current = true;
    setLaunching(true);
    setError('');
    try {
      const result = await window.workspace!.launchAgents(
        projectId,
        Object.entries(counts)
          .filter(([, count]) => count > 0)
          .map(([agentId, count]) => ({ agentId, count })),
        shell,
        workspaceName,
      );
      onLaunched(result.created);
      if (result.errors.length) {
        setCounts({});
        setRemaining((n) => n - result.created.length);
        setError(`${result.created.length} terminals opened. ${result.errors.join(' ')}`);
      } else onClose();
    } catch (e) {
      setError(String(e).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''));
    } finally {
      launchInFlight.current = false;
      setLaunching(false);
    }
  }
  return (
    <Backdrop
      className="modal-backdrop agent-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !launching) onClose();
      }}
    >
      <MotionDialog
        as="section"
        dialogRef={dialogRef}
        className="agent-launcher"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-launcher-title"
      >
        <header className="modal-title">
          <h2 id="agent-launcher-title">Open terminals</h2>
          <button
            autoFocus
            className="icon-button"
            disabled={launching}
            aria-label="Close agent launcher"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <p className="agent-intro">Choose which agents to open in {projectName}.</p>
        <div className="agent-list-heading">
          <span>Agents</span>
          <button className="text-button" disabled={loading || launching} onClick={() => refresh(false, true)}>
            <RefreshCw size={12} />
            {loading ? 'Checking…' : 'Refresh availability'}
          </button>
        </div>
        <div className="agent-options">
          {agents.map((agent) => {
            const count = counts[agent.id] || 0;
            return (
              <div
                key={agent.id}
                className={`agent-option ${count ? 'chosen' : ''} ${!agent.installed ? 'unavailable' : ''}`}
              >
                <button
                  className="agent-select"
                  aria-pressed={count > 0}
                  disabled={
                    !agent.installed || launching || loading || (!count && total >= remaining)
                  }
                  onClick={() => changeCount(agent.id, (current) => (current ? 0 : 1))}
                >
                  <AgentLogo agentId={agent.id} size={18} className="agent-mark" />
                  <span className="agent-option-name">
                    {agent.label}
                    {!agent.installed && <small>Unavailable</small>}
                  </span>
                  <span className="agent-check">{count > 0 && <Check size={12} />}</span>
                </button>
                <div className="agent-quantity">
                  <span>Count</span>
                  <button
                    aria-label={`Fewer ${agent.label} terminals`}
                    disabled={launching || loading || count === 0}
                    onClick={() => changeCount(agent.id, (current) => current - 1)}
                  >
                    <Minus size={12} />
                  </button>
                  <output aria-label={`${agent.label} terminal count`} aria-live="polite">
                    {count}
                  </output>
                  <button
                    aria-label={`More ${agent.label} terminals`}
                    disabled={launching || loading || total >= remaining}
                    onClick={() => changeCount(agent.id, (current) => current + 1)}
                  >
                    <Plus size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {loading && !agents.length && <p className="muted">Checking installed CLIs…</p>}
        {!!counts.terminal && (
          <label className="agent-shell">
            Plain terminal shell
            <select value={shell} disabled={launching} onChange={(e) => setShell(e.target.value)}>
              {shells.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && (
          <p className="agent-error" role="alert">
            {error}
          </p>
        )}
        <footer className="agent-launch-footer">
          <div>
            <strong>
              {total} {total === 1 ? 'terminal' : 'terminals'} selected
            </strong>
            <small>
              {remaining} {remaining === 1 ? 'slot' : 'slots'} left in {workspaceName}
              {total > remaining ? ' · Reduce your selection' : ''}
            </small>
          </div>
          <button
            className="primary-button"
            disabled={launching || loading || total === 0 || total > remaining}
            onClick={launch}
          >
            {launching
              ? 'Launching…'
              : `Launch ${total || ''} ${total === 1 ? 'terminal' : 'terminals'}`}
          </button>
        </footer>
      </MotionDialog>
    </Backdrop>
  );
}
