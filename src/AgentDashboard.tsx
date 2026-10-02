import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, Radio, X } from 'lucide-react';
import AgentLogo from './AgentLogo';
import { AGENT_RESPONSE_SETTLE_MS, terminalStatus, type AgentStatus } from './agentTurn';
import { displayTerminalLabel, displayTerminalTitle } from './sessionTitle';
import type { Project, TerminalInfo } from './types';
import UsagePanel from './UsagePanel';
import type { UsageReadings } from './useUsage';
import './agentDashboard.css';

type Filter = 'all' | AgentStatus;
type DashboardAgent = {
  terminal: TerminalInfo;
  project: Project;
  status: AgentStatus;
  activityAt: number;
  completedAt: number;
};

const statusOrder: AgentStatus[] = ['working', 'idle', 'done'];
const statusCopy: Record<AgentStatus, { title: string; description: string; empty: string }> = {
  working: { title: 'Active', description: 'Replying to a prompt', empty: 'No agent is replying right now.' },
  idle: { title: 'Idle', description: 'Waiting for a first prompt', empty: 'Every agent has been prompted.' },
  done: { title: 'Complete', description: 'Finished or exited', empty: 'No agent has finished yet.' },
};

function relativeTime(timestamp: number, now: number) {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function agentTime(status: AgentStatus, activityAt: number, completedAt: number, now: number) {
  if (status === 'done') {
    const at = completedAt || activityAt;
    return at ? `Finished ${relativeTime(at, now)}` : 'Finished';
  }
  return activityAt ? `Active ${relativeTime(activityAt, now)}` : 'Not prompted yet';
}

export default function AgentDashboard({
  projects,
  activeProject,
  terminals,
  activity,
  turns,
  now,
  usage,
  usageLoading,
  usageError,
  onRefreshUsage,
  onOpen,
  onNewAgent,
  onOpenProject,
  onClose,
}: {
  projects: Project[];
  activeProject: string | null;
  terminals: TerminalInfo[];
  activity: Map<string, number>;
  turns: ReadonlyMap<string, { submittedAt: number; completedAt?: number }>;
  now: number;
  usage: UsageReadings | null;
  usageLoading: boolean;
  usageError?: string | null;
  onRefreshUsage: () => void;
  onOpen: (terminal: TerminalInfo) => void;
  onNewAgent: () => void;
  onOpenProject: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'agents' | 'usage'>('agents');
  const tabsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = tabsRef.current;
    const active = bar?.querySelector<HTMLElement>('button.active');
    if (!bar || !active) return;
    bar.style.setProperty('--tab-x', `${active.offsetLeft}px`);
    bar.style.setProperty('--tab-w', `${active.offsetWidth}px`);
  }, [tab]);
  const [filter, setFilter] = useState<Filter>('all');
  const [scope, setScope] = useState<'all' | 'project'>('all');
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const agents: DashboardAgent[] = terminals
    .filter((terminal) => terminal.agentId && terminal.agentId !== 'terminal')
    .filter((terminal) => scope === 'all' || terminal.projectId === activeProject)
    .flatMap((terminal) => {
      const project = projectById.get(terminal.projectId);
      if (!project) return [];
      const turn = turns.get(terminal.id);
      // Launch banners and initial CLI setup can produce output before the user sends a prompt.
      const promptedAt = Math.max(terminal.lastInputAt || 0, turn?.submittedAt || 0);
      const activityAt = promptedAt
        ? Math.max(terminal.lastOutputAt || 0, promptedAt, activity.get(terminal.id) || 0)
        : 0;
      const completedAt = terminal.finishedAt || turn?.completedAt || 0;
      const status = terminalStatus(terminal, turn);
      return [{ terminal, project, status, activityAt, completedAt }];
    });
  const counts = {
    all: agents.length,
    working: agents.filter((agent) => agent.status === 'working').length,
    idle: agents.filter((agent) => agent.status === 'idle').length,
    done: agents.filter((agent) => agent.status === 'done').length,
  };
  // Under "All", empty groups are left out; picking a status always shows its group.
  const visible = statusOrder
    .filter((status) => (filter === 'all' ? counts[status] > 0 : filter === status))
    .map((status) => ({
      status,
      agents: agents
        .filter((agent) => agent.status === status)
        .sort((a, b) =>
          status === 'done'
            ? b.completedAt - a.completedAt
            : b.activityAt - a.activityAt,
        ),
    }));
  const total = counts.all || 1;

  return (
    <aside id="agent-dashboard" className="agent-dashboard" aria-label="Agent dashboard">
      <header className="agent-dashboard-topbar">
        <h2>Dashboard</h2>
        <div className="agent-dashboard-topbar-actions">
          <button className="agent-dashboard-close" aria-label="Close dashboard" title="Close dashboard" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="agent-dashboard-tabs" role="tablist" aria-label="Dashboard view" ref={tabsRef}>
        <span className="agent-dashboard-tab-indicator" aria-hidden="true" />
        {(['agents', 'usage'] as const).map((item) => (
          <button
            key={item}
            role="tab"
            className={tab === item ? 'active' : ''}
            aria-selected={tab === item}
            onClick={() => setTab(item)}
          >
            {item === 'agents' ? 'Overview' : 'Usage'}
          </button>
        ))}
      </div>
      <div className="agent-dashboard-inner agent-dashboard-pane" key={tab}>
        {tab === 'usage' ? (
          <UsagePanel usage={usage} loading={usageLoading} error={usageError} now={now} onRefresh={onRefreshUsage} />
        ) : (<>
        <div className="agent-dashboard-scope" role="group" aria-label="Project scope">
          <button className={scope === 'all' ? 'active' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All projects</button>
          <button className={scope === 'project' ? 'active' : ''} aria-pressed={scope === 'project'} disabled={!activeProject} onClick={() => setScope('project')}>Current project</button>
        </div>

        <div className="agent-dashboard-summary">
          <div className="agent-dashboard-filters" role="group" aria-label="Filter agents by status">
            {(['all', ...statusOrder] as const).map((item) => (
              <button
                key={item}
                className={`${item}${filter === item ? ' active' : ''}${counts[item] === 0 ? ' zero' : ''}${item === 'all' ? ' agent-dashboard-total' : ''}`}
                aria-pressed={filter === item}
                title={item === 'all' ? 'Show every agent' : statusCopy[item].description}
                onClick={() => setFilter(item)}
              >
                <strong>{counts[item]}</strong>
                <span>{item === 'all' ? 'All' : statusCopy[item].title}</span>
              </button>
            ))}
          </div>
          <div className="agent-dashboard-meter" aria-hidden="true">
            {statusOrder.map((status) => (
              <span key={status} className={status} style={{ width: `${(counts[status] / total) * 100}%` }} />
            ))}
          </div>
        </div>

        {counts.all === 0 ? (
          <div className="agent-dashboard-empty">
            <span className="agent-dashboard-empty-mark"><Radio size={20} /></span>
            <h2>{scope === 'project' ? 'No agents in this project' : 'No agents running'}</h2>
            <p>Agents you launch show up here with what they're doing.</p>
            <button onClick={activeProject ? onNewAgent : onOpenProject}>
              {activeProject ? 'Launch an agent' : 'Open a project'} <ArrowRight size={14} />
            </button>
          </div>
        ) : (
          <div className="agent-dashboard-sections">
            {visible.map(({ status, agents: items }) => (
              <section className={`agent-dashboard-section status-${status}`} key={status}>
                <div className="agent-dashboard-section-heading">
                  <h2>{statusCopy[status].title}</h2>
                  <span>{statusCopy[status].description}</span>
                </div>
                {items.length ? (
                  <div className="agent-dashboard-list">
                    {items.map(({ terminal, project, activityAt, completedAt }) => {
                      const title = displayTerminalTitle(terminal.sessionTitle, terminal.label, terminal.agentId);
                      const label = displayTerminalLabel(terminal.label, terminal.agentId);
                      const where = `${project.name} / ${terminal.workspaceName || 'Main'}`;
                      const isFailed = terminal.exited && terminal.exitCode !== undefined && terminal.exitCode !== 0;
                      return (
                        <button
                          className={`agent-dashboard-agent ${isFailed ? 'failed' : status}`}
                          key={terminal.id}
                          onClick={() => onOpen(terminal)}
                        >
                          <span className="agent-dashboard-agent-logo">
                            <AgentLogo agentId={terminal.agentId} size={20} />
                            <i aria-hidden="true" />
                          </span>
                          <span className="agent-dashboard-agent-identity">
                            <strong>{title}</strong>
                            <small>{label && label !== title ? `${label} in ${where}` : where}</small>
                          </span>
                          <span className="agent-dashboard-agent-time">
                            {isFailed ? `Exited with code ${terminal.exitCode}` : agentTime(status, activityAt, completedAt, now)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="agent-dashboard-section-empty">{statusCopy[status].empty}</p>
                )}
              </section>
            ))}
          </div>
        )}
        <p className="agent-dashboard-note">
          An agent counts as complete after {AGENT_RESPONSE_SETTLE_MS / 1000} seconds without output. Prompting it again moves it back to active.
        </p>
        </>)}
      </div>
    </aside>
  );
}
