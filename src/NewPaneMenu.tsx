import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Files, Globe, LoaderCircle, PanelBottom, Plus, SquareTerminal, Zap } from 'lucide-react';
import type { AgentOption } from './types';
import AgentLogo from './AgentLogo';
import { motion, useIsPresent } from 'motion/react';
import { PopoverSurface, surfaceMotion } from './motion';

type AgentList = { agents: AgentOption[]; remaining: number };
const agentCache = new Map<string, AgentList>();
const cacheKey = (projectId: string, workspaceName: string) => `${projectId}\n${workspaceName}`;

function loadAgents(projectId: string, workspaceName: string) {
  return window.workspace!.listAgents(projectId, workspaceName).then((result) => {
    const list = { agents: result.agents, remaining: result.remaining };
    agentCache.set(cacheKey(projectId, workspaceName), list);
    return list;
  });
}

export function getCachedPaneAgents(projectId: string, workspaceName: string) {
  return agentCache.get(cacheKey(projectId, workspaceName));
}

/* Warm the agent list before the menu opens so it renders at full size at once. */
export function prefetchPaneAgents(projectId: string, workspaceName: string) {
  if (!agentCache.has(cacheKey(projectId, workspaceName)))
    loadAgents(projectId, workspaceName).catch(() => {});
}

export default function NewPaneMenu({
  projectId,
  projectPath,
  workspaceName,
  anchor,
  onClose,
  onTerminal,
  onFiles,
  onBrowser,
  onAgent,
  onMoreOptions,
  onNewWorkspace,
}: {
  projectId: string;
  projectPath: string;
  workspaceName: string;
  anchor: HTMLButtonElement;
  onClose(): void;
  onTerminal(): Promise<void> | void;
  onFiles(): void;
  onBrowser(): void;
  onAgent(agent: AgentOption): Promise<void> | void;
  onMoreOptions(): void;
  onNewWorkspace(): Promise<void> | void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const isPresent = useIsPresent();
  const [placement, setPlacement] = useState<{ left: number; top: number; origin: string } | null>(
    null,
  );
  const cached = agentCache.get(cacheKey(projectId, workspaceName));
  const [agents, setAgents] = useState<AgentOption[]>(
    cached?.agents.filter((agent) => agent.installed && agent.id !== 'terminal') || [],
  );
  const [loading, setLoading] = useState(!cached);
  const [remaining, setRemaining] = useState(cached?.remaining ?? 0);

  useEffect(() => {
    let cancelled = false;
    loadAgents(projectId, workspaceName)
      .then((result) => {
        if (cancelled) return;
        setAgents(result.agents.filter((agent) => agent.installed && agent.id !== 'terminal'));
        setRemaining(result.remaining);
      })
      .catch(() => {
        if (!cancelled && !agentCache.has(cacheKey(projectId, workspaceName))) setAgents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, workspaceName]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const place = () => {
      if (!anchor.isConnected) return;
      const trigger = anchor.getBoundingClientRect();
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const margin = 8;
      const gap = 6;
      const below =
        trigger.bottom + gap + height <= innerHeight - margin ||
        trigger.top - gap - height < margin;
      const left = Math.max(margin, Math.min(trigger.right - width, innerWidth - width - margin));
      const top = below
        ? Math.max(margin, Math.min(trigger.bottom + gap, innerHeight - height - margin))
        : Math.max(margin, trigger.top - height - gap);
      const origin = below ? 'top right' : 'bottom right';
      setPlacement((current) =>
        current?.left === left && current.top === top && current.origin === origin
          ? current
          : { left, top, origin },
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  useEffect(() => {
    if (!isPresent) return;
    const focusFrame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (menuRef.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', dismiss, true);
    };
  }, [anchor, isPresent, onClose]);

  function choose(action: () => Promise<void> | void) {
    onClose();
    void action();
  }

  function navigate(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchor.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []),
    ];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length;
    items[index].focus();
  }

  return (
    <motion.div
      {...surfaceMotion()}
      ref={menuRef}
      className="new-pane-menu"
      role="menu"
      aria-label="New agent"
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        transformOrigin: placement?.origin,
        visibility: placement ? 'visible' : 'hidden',
      }}
      onKeyDown={navigate}
    >
      <PopoverSurface origin={placement?.origin} />
      <div className="new-pane-menu-content">
        <header className="new-pane-menu-header">
          <strong>New agent</strong>
          <span title={projectPath}>{projectPath}</span>
        </header>

        <div className="new-pane-menu-section">
          <button
            role="menuitem"
            disabled={remaining === 0 && !loading}
            onClick={() => choose(onTerminal)}
          >
            <SquareTerminal size={14} />
            <span>Terminal</span>
            <kbd>Ctrl `</kbd>
          </button>
          <button role="menuitem" onClick={() => choose(onFiles)}>
            <Files size={14} />
            <span>Files</span>
          </button>
          <button role="menuitem" onClick={() => choose(onBrowser)}>
            <Globe size={14} />
            <span>Browser</span>
          </button>
        </div>

        <div className="new-pane-menu-section agent-pane-options">
          {loading ? (
            <button role="menuitem" disabled>
              <LoaderCircle className="spinning" size={14} />
              <span>Checking agents...</span>
            </button>
          ) : agents.length ? (
            agents.map((agent) => (
              <button
                key={agent.id}
                role="menuitem"
                disabled={remaining < 1}
                title={`Open ${agent.label}`}
                onClick={() => choose(() => onAgent(agent))}
              >
                <AgentLogo agentId={agent.id} size={15} className="new-pane-agent-mark" />
                <span>{agent.label}</span>
              </button>
            ))
          ) : (
            <button role="menuitem" disabled>
              <Zap size={14} />
              <span>No agents found</span>
            </button>
          )}
        </div>

        <div className="new-pane-menu-section">
          <button role="menuitem" onClick={() => choose(onMoreOptions)}>
            <PanelBottom size={14} />
            <span>Launch multiple...</span>
          </button>
          <button role="menuitem" onClick={() => choose(onNewWorkspace)}>
            <Plus size={14} />
            <span>New workspace...</span>
          </button>
        </div>
      </div>
    </motion.div>
  );
}
