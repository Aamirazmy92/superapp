import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, Plus, X } from './icons';
import { useCollapse, useStackMotion } from './motion';
import ChatFiles, { ChatFilesEmpty } from './ChatFiles';
import WorkspaceBrowser from './WorkspaceBrowser';
import { displayTerminalTitle } from './sessionTitle';
import type { Preferences } from './preferences';
import type { Project, TerminalInfo } from './types';

const TerminalPane = lazy(() => import('./TerminalPane'));
// Chat terminals live in their own workspace, so they never crowd the Code view's panes.
const WORKSPACE = 'Chat';
const WIDTH_MIN = 300;
const SPLIT_MIN = 0.18;
const layoutKey = 'chat-side-layout';
type Pane = 'browser' | 'terminal' | 'files';

// split: Terminal's share of the space under the browser; browser: the browser's share of the column.
function readLayout(): { width: number; split: number; browser: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(layoutKey) || '{}');
    return {
      width: Number.isFinite(saved.width) ? saved.width : 460,
      split: Number.isFinite(saved.split) ? saved.split : 0.45,
      browser: Number.isFinite(saved.browser) ? saved.browser : 0.5,
    };
  } catch {
    return { width: 460, split: 0.45, browser: 0.5 };
  }
}

/**
 * The chat's right-hand column, like Claude Code's: Browser, Terminal and Files
 * panes, stacked in that order when more than one is open. Its width, the splits
 * between the panes and the editor/tree split inside Files can all be dragged.
 */
export default function ChatSide({
  project,
  preferences,
  filesOpen,
  terminalOpen,
  browserOpen,
  openRequest,
  onFilesOpenChange,
  onTerminalOpenChange,
  onBrowserOpenChange,
  onSendToChat,
}: {
  project?: Project;
  preferences: Preferences;
  filesOpen: boolean;
  terminalOpen: boolean;
  browserOpen: boolean;
  openRequest?: { path: string; line?: number; nonce: number } | null;
  onFilesOpenChange(open: boolean): void;
  onTerminalOpenChange(open: boolean): void;
  onBrowserOpenChange(open: boolean): void;
  // A change request picked from a page in the browser goes to the chat composer.
  onSendToChat(prompt: string): Promise<void>;
}) {
  const [layout, setLayout] = useState(readLayout);
  const [maximized, setMaximized] = useState<Pane | null>(null);
  const column = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const shown = filesOpen || terminalOpen || browserOpen;
  // The column slides in with its first pane and out with its last, showing the panes it
  // held until it has gone.
  const hidden = useCollapse(() => column.current, shown, { anchor: 'end' });
  const panesNow = { files: filesOpen, terminal: terminalOpen, browser: browserOpen };
  const lastPanes = useRef(panesNow);
  if (shown) lastPanes.current = panesNow;
  const panes = shown ? panesNow : lastPanes.current;
  const both = panes.files && panes.terminal && !maximized;
  // Files and the browser stay mounted once opened, so open tabs, unsaved edits and
  // loaded pages survive closing them.
  const [filesVisited, setFilesVisited] = useState(filesOpen);
  const [browserVisited, setBrowserVisited] = useState(browserOpen);
  useEffect(() => {
    if (filesOpen) setFilesVisited(true);
  }, [filesOpen]);
  useEffect(() => {
    if (browserOpen) setBrowserVisited(true);
  }, [browserOpen]);
  useEffect(() => {
    if (maximized === 'files' && !filesOpen) setMaximized(null);
    if (maximized === 'terminal' && !terminalOpen) setMaximized(null);
    if (maximized === 'browser' && !browserOpen) setMaximized(null);
  }, [filesOpen, terminalOpen, browserOpen, maximized]);
  useEffect(() => {
    try {
      localStorage.setItem(layoutKey, JSON.stringify(layout));
    } catch {}
  }, [layout]);

  // The conversation and composer make room for the column (see --side-w in chat.css).
  useLayoutEffect(() => {
    const main = column.current?.closest<HTMLElement>('.chat-main');
    if (!main) return;
    if (shown) main.style.setProperty('--side-w', `${layout.width + 16}px`);
    else main.style.removeProperty('--side-w');
    return () => {
      main.style.removeProperty('--side-w');
    };
  }, [shown, layout.width]);

  function widthLimit() {
    const main = column.current?.closest<HTMLElement>('.chat-main');
    // Keep at least a usable conversation beside the column.
    return Math.max(WIDTH_MIN, (main?.getBoundingClientRect().width ?? 1200) - 380);
  }
  function drag(
    event: React.PointerEvent<HTMLDivElement>,
    apply: (start: { x: number; y: number }, now: PointerEvent) => void,
    cursor: 'col' | 'row',
  ) {
    if (event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY };
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add(cursor === 'col' ? 'panel-resizing' : 'row-resizing');
    const move = (now: PointerEvent) => apply(start, now);
    const end = () => {
      document.body.classList.remove('panel-resizing', 'row-resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    event.preventDefault();
  }
  function startWidthDrag(event: React.PointerEvent<HTMLDivElement>) {
    const startWidth = layout.width;
    const limit = widthLimit();
    // The column is on the right, so dragging left widens it.
    drag(
      event,
      (start, now) =>
        setLayout((value) => ({
          ...value,
          width: Math.round(Math.max(WIDTH_MIN, Math.min(limit, startWidth + start.x - now.clientX))),
        })),
      'col',
    );
  }
  function startBrowserDrag(event: React.PointerEvent<HTMLDivElement>) {
    const startBrowser = layout.browser;
    const height = column.current?.getBoundingClientRect().height || 1;
    drag(
      event,
      (start, now) =>
        setLayout((value) => ({
          ...value,
          browser: Math.max(SPLIT_MIN, Math.min(1 - SPLIT_MIN, startBrowser + (now.clientY - start.y) / height)),
        })),
      'row',
    );
  }
  function startSplitDrag(event: React.PointerEvent<HTMLDivElement>) {
    const startSplit = layout.split;
    const height = stack.current?.getBoundingClientRect().height || 1;
    drag(
      event,
      (start, now) =>
        setLayout((value) => ({
          ...value,
          split: Math.max(SPLIT_MIN, Math.min(1 - SPLIT_MIN, startSplit + (now.clientY - start.y) / height)),
        })),
      'row',
    );
  }
  const terminalShown = panes.terminal && (!maximized || maximized === 'terminal');
  const filesShown = panes.files && (!maximized || maximized === 'files');
  const browserShown = panes.browser && (!maximized || maximized === 'browser');
  const stackShown = terminalShown || filesShown;
  // Panes opening or closing beside others grow and shrink in place.
  useStackMotion(column, `${+browserShown}${+stackShown}`);
  useStackMotion(stack, `${+terminalShown}${+filesShown}`);

  return (
    <div
      ref={column}
      className={`chat-side ${maximized ? 'maximized' : ''}`}
      style={{ display: hidden ? 'none' : undefined, width: maximized ? 'calc(100% - 16px)' : layout.width }}
      aria-label="Side panes"
    >
      <div
        className="chat-side-handle vertical edge"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side panes"
        aria-valuenow={layout.width}
        aria-valuemin={WIDTH_MIN}
        tabIndex={0}
        onPointerDown={startWidthDrag}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const step = (event.shiftKey ? 48 : 16) * (event.key === 'ArrowLeft' ? 1 : -1);
          setLayout((value) => ({
            ...value,
            width: Math.max(WIDTH_MIN, Math.min(widthLimit(), value.width + step)),
          }));
        }}
      />
      {(browserVisited || browserOpen) && (
        <div
          className="chat-side-slot chat-browser-slot"
          data-stack-item
          style={
            !browserShown
              ? { display: 'none' }
              : stackShown
                ? { flex: `0 0 calc(${layout.browser * 100}% - 4px)` }
                : { flex: '1 1 auto' }
          }
        >
          <WorkspaceBrowser
            isFullscreen={maximized === 'browser'}
            onClose={() => onBrowserOpenChange(false)}
            onSendToAgent={onSendToChat}
            onToggleFullscreen={() => setMaximized(maximized === 'browser' ? null : 'browser')}
          />
        </div>
      )}
      {/* Handles stay mounted while hidden, so the gap they make can open and close smoothly. */}
      <div
          className="chat-side-handle horizontal"
          data-stack-item
          style={browserShown && stackShown ? undefined : { display: 'none' }}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize browser"
          aria-valuenow={Math.round(layout.browser * 100)}
          aria-valuemin={Math.round(SPLIT_MIN * 100)}
          aria-valuemax={Math.round((1 - SPLIT_MIN) * 100)}
          tabIndex={0}
          title="Resize"
          onPointerDown={startBrowserDrag}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const step = event.key === 'ArrowUp' ? -0.04 : 0.04;
            setLayout((value) => ({
              ...value,
              browser: Math.max(SPLIT_MIN, Math.min(1 - SPLIT_MIN, value.browser + step)),
            }));
          }}
        />
      <div
        ref={stack}
        className="chat-side-stack"
        data-stack-item
        style={stackShown ? undefined : { display: 'none' }}
      >
      <div
        className="chat-side-slot"
        data-stack-item
        style={
          !terminalShown
            ? { display: 'none' }
            : both
              ? { flex: `0 0 calc(${layout.split * 100}% - 4px)` }
              : { flex: '1 1 auto' }
        }
      >
        {project ? (
          <ChatTerminal
            project={project}
            preferences={preferences}
            open={terminalOpen}
            expanded={maximized === 'terminal'}
            onToggleExpand={() => setMaximized(maximized === 'terminal' ? null : 'terminal')}
            onClose={() => onTerminalOpenChange(false)}
          />
        ) : (
          <ChatTerminalEmpty onClose={() => onTerminalOpenChange(false)} />
        )}
      </div>
      <div
          className="chat-side-handle horizontal"
          data-stack-item
          style={both ? undefined : { display: 'none' }}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal and files"
          aria-valuenow={Math.round(layout.split * 100)}
          aria-valuemin={Math.round(SPLIT_MIN * 100)}
          aria-valuemax={Math.round((1 - SPLIT_MIN) * 100)}
          tabIndex={0}
          title="Resize"
          onPointerDown={startSplitDrag}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const step = event.key === 'ArrowUp' ? -0.04 : 0.04;
            setLayout((value) => ({
              ...value,
              split: Math.max(SPLIT_MIN, Math.min(1 - SPLIT_MIN, value.split + step)),
            }));
          }}
        />
      {(filesVisited || filesOpen) && (
        <div className="chat-side-slot" data-stack-item style={filesShown ? undefined : { display: 'none' }}>
          {project ? (
            <ChatFiles
              projectId={project.id}
              projectName={project.name}
              preferences={preferences}
              expanded={maximized === 'files'}
              openRequest={openRequest}
              onToggleExpand={() => setMaximized(maximized === 'files' ? null : 'files')}
              onClose={() => onFilesOpenChange(false)}
            />
          ) : (
            <ChatFilesEmpty onClose={() => onFilesOpenChange(false)} />
          )}
        </div>
      )}
      </div>
    </div>
  );
}

// Terminals start in the chat's project folder, so a chat without one has nowhere to run them.
function ChatTerminalEmpty({ onClose }: { onClose(): void }) {
  return (
    <section className="chat-terminal chat-side-pane" aria-label="Terminal">
      <header className="chat-files-top">
        <strong className="chat-files-heading">Terminal</strong>
        <div className="chat-files-actions">
          <button className="icon-button" aria-label="Hide terminal" title="Hide terminal" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </header>
      <p className="chat-files-empty">Choose a project for this chat to open a terminal in it.</p>
    </section>
  );
}

type TerminalState = { terminals: TerminalInfo[]; active: string | null };

/**
 * Terminals for the chat's project. Opening the pane starts one in the project
 * folder; more can be added with +. They keep running while the pane is hidden.
 */
function ChatTerminal({
  project,
  preferences,
  open,
  expanded,
  onToggleExpand,
  onClose,
}: {
  project: Project;
  preferences: Preferences;
  open: boolean;
  expanded: boolean;
  onToggleExpand(): void;
  onClose(): void;
}) {
  const api = window.workspace!;
  const [states, setStates] = useState<Record<string, TerminalState>>({});
  const [error, setError] = useState('');
  const starting = useRef(new Set<string>());
  const state = states[project.id] ?? { terminals: [], active: null };
  const active = state.terminals.find((item) => item.id === state.active) ?? state.terminals[0];
  const update = (id: string, change: (value: TerminalState) => TerminalState) =>
    setStates((previous) => ({ ...previous, [id]: change(previous[id] ?? { terminals: [], active: null }) }));

  async function start() {
    const id = project.id;
    try {
      setError('');
      const next = await api.createTerminal(id, undefined, WORKSPACE);
      update(id, (value) => ({ terminals: [...value.terminals, next], active: next.id }));
    } catch (value) {
      setError(String(value).replace(/^Error:.*?Error: /, '').replace(/^Error: /, ''));
    }
  }
  // The first time the pane opens for a project, it starts a terminal there.
  useEffect(() => {
    if (!open || state.terminals.length || starting.current.has(project.id)) return;
    starting.current.add(project.id);
    void start().finally(() => starting.current.delete(project.id));
  }, [open, project.id, state.terminals.length]);

  async function closeTerminal(info: TerminalInfo) {
    const id = project.id;
    update(id, (value) => {
      const terminals = value.terminals.filter((item) => item.id !== info.id);
      return { terminals, active: value.active === info.id ? (terminals.at(-1)?.id ?? null) : value.active };
    });
    if (!info.exited) await api.closeTerminal(info.id).catch(() => {});
    if (state.terminals.length <= 1) onClose();
  }
  const title = (info: TerminalInfo) => displayTerminalTitle(info.sessionTitle, info.label, info.agentId);

  return (
    <section className="chat-terminal chat-side-pane" aria-label="Terminal">
      <header className="chat-files-top">
        <strong className="chat-files-heading">Terminal</strong>
        {state.terminals.length > 1 ? (
          <div className="chat-files-tabs" role="tablist" aria-label="Terminals">
            {state.terminals.map((info) => (
              <div key={info.id} className={`chat-files-tab ${info.id === active?.id ? 'active' : ''}`}>
                <button
                  role="tab"
                  aria-selected={info.id === active?.id}
                  title={title(info)}
                  onClick={() => update(project.id, (value) => ({ ...value, active: info.id }))}
                >
                  <span>{title(info)}</span>
                </button>
                <button
                  className="chat-files-tab-close"
                  aria-label={`Close ${title(info)}`}
                  title="Close terminal"
                  onClick={() => void closeTerminal(info)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          active && <span className="chat-terminal-title" title={title(active)}>{title(active)}</span>
        )}
        <div className="chat-files-actions">
          <button className="icon-button" aria-label="New terminal" title="New terminal" onClick={() => void start()}>
            <Plus size={15} />
          </button>
          <button
            className="icon-button"
            aria-label={expanded ? 'Restore terminal' : 'Expand terminal'}
            aria-pressed={expanded}
            title={expanded ? 'Restore' : 'Expand'}
            onClick={onToggleExpand}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="icon-button" aria-label="Hide terminal" title="Hide terminal" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </header>
      {error && (
        <p className="chat-files-error" role="alert">
          {error}
        </p>
      )}
      <div className="chat-terminal-body">
        <Suspense fallback={<p className="chat-files-hint">Starting terminal…</p>}>
          {state.terminals.map((info) => (
            <div key={info.id} className="chat-terminal-slot" style={info.id === active?.id ? undefined : { display: 'none' }}>
              <TerminalPane
                bare
                info={info}
                preferences={preferences}
                onClose={() => void closeTerminal(info)}
                onFullScreen={onToggleExpand}
                onNewPane={() => void start()}
                newPaneMenuOpen={false}
                isFullScreen={expanded}
                isActive={info.id === active?.id}
                onActivate={() => {}}
                onInput={() => {}}
                onExit={(id, code) =>
                  update(project.id, (value) => ({
                    ...value,
                    terminals: value.terminals.map((item) =>
                      item.id === id ? { ...item, exited: true, exitCode: code } : item,
                    ),
                  }))
                }
                onError={(value) => setError(String(value))}
                canMove={false}
                onMoveKey={() => {}}
                dragHandlers={{}}
              />
            </div>
          ))}
        </Suspense>
        {!state.terminals.length && !error && <p className="chat-files-hint">Starting terminal…</p>}
      </div>
    </section>
  );
}
