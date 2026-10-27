import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { X, Circle, ImagePlus, LoaderCircle, Maximize2, Plus } from './icons';
import AgentLogo from './AgentLogo';
import type { TerminalInfo, TerminalEvent } from './types';
import { displayTerminalLabel, displayTerminalTitle } from './sessionTitle';
import '@xterm/xterm/css/xterm.css';
import { fontStack, type Preferences } from './preferences';
import { terminalTheme } from './themes';
import { acceptsDrop, pasteTarget, quotePath, readDrop, resolveDrop } from './terminalDrop';

type TerminalMoveKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

const terminalFont = (preferences: Preferences) =>
  fontStack(
    preferences.terminalFontFamily === 'editor'
      ? preferences.fontFamily
      : preferences.terminalFontFamily,
  );

// Refits after a panel opens or closes run one terminal per frame. Each one resizes a WebGL
// canvas, which takes tens of milliseconds; doing every terminal in the same frame stalled the
// page for a few hundred.
const fitQueue: (() => void)[] = [];
let fitQueueFrame: number | null = null;
function queueFit(fit: () => void) {
  if (!fitQueue.includes(fit)) fitQueue.push(fit);
  if (fitQueueFrame === null) fitQueueFrame = requestAnimationFrame(drainFitQueue);
}
function drainFitQueue() {
  fitQueueFrame = null;
  fitQueue.shift()?.();
  if (fitQueue.length) fitQueueFrame = requestAnimationFrame(drainFitQueue);
}
function unqueueFit(fit: () => void) {
  const index = fitQueue.indexOf(fit);
  if (index >= 0) fitQueue.splice(index, 1);
}

/*
 * The WebGL renderer watches its canvas's device-pixel size and reallocates the canvas whenever
 * it changes. At fractional display scaling (125%, 150%) a pane sliding through fractional
 * positions changes that size by a pixel on most frames, so every terminal reallocated its
 * canvas (20-40ms each) on every frame of a panel animation, which is what made the terminals
 * stutter. Those one-pixel changes are held while a panel slides and the last one is applied
 * once it settles. This reaches into the addon's renderer, so it does nothing if that changes.
 */
function holdCanvasResizesDuringSlides(webgl: WebglAddon) {
  const renderer = (webgl as unknown as { _renderer?: Record<string, unknown> })._renderer;
  const original = renderer?._setCanvasDevicePixelDimensions;
  if (!renderer || typeof original !== 'function') return () => {};
  let held: [number, number] | null = null;
  renderer._setCanvasDevicePixelDimensions = (width: number, height: number) => {
    if (document.body.classList.contains('dashboard-layout-transitioning')) {
      held = [width, height];
      return;
    }
    held = null;
    original.call(renderer, width, height);
  };
  const release = () => {
    if (!held) return;
    const [width, height] = held;
    held = null;
    original.call(renderer, width, height);
  };
  window.addEventListener('dashboard-layout-settled', release);
  return () => window.removeEventListener('dashboard-layout-settled', release);
}

export default function TerminalPane({
  info,
  preferences,
  onClose,
  onFullScreen,
  onNewPane,
  newPaneMenuOpen,
  isFullScreen,
  isActive,
  onActivate,
  onInput,
  onExit,
  onError,
  moveState,
  gridColumnSpan,
  beaconNonce,
  canMove,
  onMoveKey,
  dragHandlers,
  bare = false,
}: {
  info: TerminalInfo;
  preferences: Preferences;
  onClose(): void;
  onFullScreen(): void;
  onNewPane(event: React.MouseEvent<HTMLButtonElement>): void;
  newPaneMenuOpen: boolean;
  isFullScreen: boolean;
  isActive: boolean;
  onActivate(): void;
  onInput(data: string): void;
  onExit(id: string, code: number): void;
  onError(error: unknown): void;
  moveState?: 'dragging';
  gridColumnSpan?: number;
  beaconNonce?: number;
  canMove: boolean;
  onMoveKey(key: TerminalMoveKey): void;
  dragHandlers: React.HTMLAttributes<HTMLElement>;
  /** Without its own header, for hosts that supply one (the chat Terminal pane). */
  bare?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<(() => void) | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  // Agent CLIs take a few seconds to draw anything; show that they're starting
  // instead of an empty pane until the first readable output arrives.
  const [booting, setBooting] = useState(!!info.agentId && !info.exited);
  const callbacks = useRef({ onExit, onError, onActivate, onInput });
  callbacks.current = { onExit, onError, onActivate, onInput };
  const infoRef = useRef(info);
  infoRef.current = info;
  // Files and images dragged onto the terminal; see terminalDrop.ts.
  const [dropState, setDropState] = useState<'over' | 'saving' | null>(null);
  const dragDepth = useRef(0);
  const canDrop = (event: React.DragEvent) =>
    !info.exited && dropState !== 'saving' && acceptsDrop(event.dataTransfer.types);
  async function dropFiles(event: React.DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    const items = readDrop(event.dataTransfer);
    setDropState('saving');
    try {
      const paths = await resolveDrop(items, window.workspace!);
      const term = terminalRef.current;
      if (!paths.length) throw new Error('Drop an image or a file to add it to the terminal.');
      if (!term || infoRef.current.exited) return;
      const target = pasteTarget(infoRef.current.shell, infoRef.current.agentId);
      term.paste(paths.map((item) => quotePath(item, target)).join(' '));
      onActivate();
      term.focus();
    } catch (error) {
      callbacks.current.onError(error);
    } finally {
      setDropState(null);
    }
  }
  useEffect(() => {
    const api = window.workspace!;
    const term = new Terminal({
      cursorBlink: preferences.cursorBlink,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'outline',
      cursorWidth: 2,
      fontFamily: terminalFont(preferences),
      fontSize: preferences.terminalFontSize,
      lineHeight: 1.4,
      customGlyphs: true,
      scrollback: preferences.scrollback,
      theme: terminalTheme(preferences.theme, preferences.pluginTheme),
    });
    terminalRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    // The WebGL renderer draws block/box characters as full-cell shapes, so art like the
    // Claude logo stays solid despite lineHeight; the DOM renderer leaves gaps between rows.
    let releaseCanvasHold = () => {};
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
      releaseCanvasHold = holdCanvasResizesDuringSlides(webgl);
    } catch {
      // WebGL unavailable: keep the default DOM renderer.
    }
    let disposed = false;
    term.attachCustomKeyEventHandler((event) => {
      // xterm sends a plain CR for Shift+Enter, which submits. Send LF (Ctrl+J) instead,
      // which Claude Code and Codex treat as "insert newline".
      if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (event.type === 'keydown') {
          event.preventDefault();
          api.writeTerminal(info.id, '\n').catch((error) => callbacks.current.onError(error));
        }
        return false;
      }
      if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey) || event.altKey)
        return true;
      const key = event.key.toLowerCase();
      if (key === 'c' && (event.shiftKey || term.hasSelection())) {
        event.preventDefault();
        const selected = term.getSelection();
        if (selected)
          api.writeTerminalClipboard(selected).catch((error) => callbacks.current.onError(error));
        return false;
      }
      if (key === 'v') {
        event.preventDefault();
        api.readTerminalClipboard()
          .then(({ text, hasImage }) => {
            if (disposed) return;
            if (hasImage) {
              // The agent reads the image from the clipboard itself; send its paste key.
              // Claude Code on Windows binds image paste to Alt+V, Codex to Ctrl+V.
              const current = infoRef.current;
              const isClaude =
                current.agentId === 'claude' || /\bclaude\b/i.test(current.sessionTitle ?? '');
              api
                .writeTerminal(info.id, isClaude ? '\x1bv' : '\x16')
                .catch((error) => callbacks.current.onError(error));
            } else if (text) {
              term.paste(text);
            }
          })
          .catch((error) => callbacks.current.onError(error));
        return false;
      }
      return true;
    });
    let ready = false;
    let sequence = -1;
    const pending: TerminalEvent[] = [];
    const markStarted = (data: string) => {
      if (hasReadableText(data)) setBooting(false);
    };
    const apply = (event: TerminalEvent) => {
      if (event.seq <= sequence || disposed) return;
      sequence = event.seq;
      if (event.data) {
        term.write(event.data);
        markStarted(event.data);
      }
      if (event.exitCode !== undefined) {
        setBooting(false);
        term.write(`\r\n\x1b[90m[Process exited with code ${event.exitCode}]\x1b[0m\r\n`);
        callbacks.current.onExit(info.id, event.exitCode);
      }
    };
    const unsubscribe = api.onTerminal((event) => {
      if (event.id !== info.id) return;
      if (!ready) pending.push(event);
      else apply(event);
    });
    let resizeFrame: number | null = null;
    let sentCols = 0;
    let sentRows = 0;
    let dashboardResizePending = false;
    let ptyResizeTimer: ReturnType<typeof setTimeout> | undefined;
    const sendPtySize = () => {
      ptyResizeTimer = undefined;
      if (disposed || (term.cols === sentCols && term.rows === sentRows)) return;
      sentCols = term.cols;
      sentRows = term.rows;
      api.resizeTerminal(info.id, sentCols, sentRows).catch(() => {});
    };
    let hidden = false;
    const fitNow = () => {
      if (disposed) return;
      if (!host.current?.clientWidth || !host.current?.clientHeight) {
        hidden = true;
        return;
      }
      fit.fit();
      if (hidden) {
        // Chromium discards a WebGL canvas's buffer while it is display:none (e.g. in
        // chat mode), and an unchanged size means fit() redraws nothing, so repaint.
        hidden = false;
        term.clearTextureAtlas();
        term.refresh(0, term.rows - 1);
      }
      clearTimeout(ptyResizeTimer);
      // xterm follows every frame of a drag, but the shell only hears about the
      // size once it holds still: each resize makes ConPTY re-emit the screen,
      // and a burst of them garbles the output.
      if (!sentCols) sendPtySize();
      else ptyResizeTimer = setTimeout(sendPtySize, 120);
    };
    const resize = () => {
      if (disposed) return;
      // While a side panel slides, the terminal keeps its size (the pane clips or pads it) and
      // refits once the slide has settled; refitting every frame would reflow it mid-animation.
      if (document.body.classList.contains('dashboard-layout-transitioning')) {
        dashboardResizePending = true;
        return;
      }
      if (disposed || resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        if (document.body.classList.contains('dashboard-layout-transitioning')) {
          dashboardResizePending = true;
          return;
        }
        fitNow();
      });
    };
    // Dispatched while the page is momentarily laid out at its final size, as a panel starts to
    // slide. Fitting here made every terminal resize its canvas at once, right as the motion
    // began, which dropped its first frames; the fit now waits until the slide settles.
    const fitToDashboardLayout = () => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = null;
      dashboardResizePending = true;
    };
    const fitQueued = () => {
      if (!disposed) fitNow();
    };
    const resizeAfterDashboardLayout = () => {
      if (!dashboardResizePending) return;
      dashboardResizePending = false;
      queueFit(fitQueued);
    };
    resizeRef.current = resize;
    api
      .attachTerminal(info.id, info.workspaceName)
      .then((snapshot) => {
        if (disposed) return;
        term.write(snapshot.output);
        markStarted(snapshot.output);
        if (snapshot.exited) setBooting(false);
        sequence = snapshot.seq;
        ready = true;
        pending.forEach(apply);
        if (snapshot.exited) callbacks.current.onExit(info.id, snapshot.exitCode ?? 0);
        resize();
      })
      .catch((error) => callbacks.current.onError(error));
    const input = term.onData((data) => {
      callbacks.current.onInput(data);
      api.writeTerminal(info.id, data).catch((error) => callbacks.current.onError(error));
    });
    const activate = term.onKey(() => callbacks.current.onActivate());
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    window.addEventListener('dashboard-layout-preview', fitToDashboardLayout);
    window.addEventListener('dashboard-layout-settled', resizeAfterDashboardLayout);
    return () => {
      disposed = true;
      terminalRef.current = null;
      resizeRef.current = null;
      unsubscribe();
      input.dispose();
      activate.dispose();
      observer.disconnect();
      window.removeEventListener('dashboard-layout-preview', fitToDashboardLayout);
      window.removeEventListener('dashboard-layout-settled', resizeAfterDashboardLayout);
      unqueueFit(fitQueued);
      releaseCanvasHold();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      clearTimeout(ptyResizeTimer);
      term.dispose();
    };
  }, [info.id]);
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = preferences.terminalFontSize;
    terminal.options.fontFamily = terminalFont(preferences);
    terminal.options.cursorBlink = preferences.cursorBlink;
    terminal.options.scrollback = preferences.scrollback;
    terminal.options.theme = terminalTheme(preferences.theme, preferences.pluginTheme);
    resizeRef.current?.();
  }, [
    preferences.terminalFontSize,
    preferences.terminalFontFamily,
    preferences.fontFamily,
    preferences.cursorBlink,
    preferences.scrollback,
    preferences.theme,
    preferences.pluginTheme,
  ]);
  useEffect(() => {
    if (!isActive) return;
    const frame = requestAnimationFrame(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      terminal.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isActive]);
  const displayLabel = displayTerminalLabel(info.label, info.agentId);
  const displayTitle = displayTerminalTitle(info.sessionTitle, info.label, info.agentId);
  return (
    <section
      id={`terminal-${info.id}`}
      className={`terminal-pane ${isActive ? 'active' : ''} ${moveState || ''} ${beaconNonce !== undefined ? 'beaconing' : ''}`}
      style={gridColumnSpan ? { gridColumn: `span ${gridColumnSpan}` } : undefined}
      aria-label={`${displayTitle} (${displayLabel})${isActive ? ', active terminal' : ''}`}
      aria-current={isActive ? 'true' : undefined}
      onPointerDown={onActivate}
      onFocusCapture={onActivate}
    >
      {beaconNonce !== undefined && <svg key={beaconNonce} className="terminal-beacon" aria-hidden="true">
          <rect className="terminal-beacon-trail" pathLength="1000" />
          <rect className="terminal-beacon-dot" pathLength="1000" />
        </svg>}
      {!bare && (
      <header
        className="terminal-pane-header"
        data-movable={canMove ? 'true' : undefined}
        tabIndex={canMove ? 0 : undefined}
        title={
          canMove
            ? `Drag to move ${displayTitle} (Esc cancels). Use arrow keys to reorder by grid position.`
            : undefined
        }
        aria-label={canMove ? `Move ${displayTitle}` : undefined}
        {...dragHandlers}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (
            event.key !== 'ArrowLeft' &&
            event.key !== 'ArrowUp' &&
            event.key !== 'ArrowRight' &&
            event.key !== 'ArrowDown'
          )
            return;
          event.preventDefault();
          onMoveKey(event.key as TerminalMoveKey);
        }}
      >
        <div
          className="terminal-pane-identity"
          title={info.exited ? `${displayTitle} exited` : displayTitle}
          aria-label={info.exited ? `${displayTitle} exited` : displayTitle}
        >
          <span className={`terminal-status-dot ${info.exited ? 'exited' : ''}`} aria-hidden="true">
            <Circle size={7} fill="currentColor" />
          </span>
          <AgentLogo agentId={info.agentId} size={14} className="terminal-pane-logo" />
          <span className="terminal-title">{displayTitle}</span>
        </div>
        <span
          className="terminal-pane-status"
          aria-label={info.exited ? `Exited ${info.exitCode}` : 'Terminal running'}
          title={info.exited ? `Exited ${info.exitCode}` : 'Terminal running'}
        >
          {info.exited ? `Exited ${info.exitCode}` : null}
        </span>
        <div className="terminal-pane-actions">
          <button
            className="icon-button"
            title={isFullScreen ? 'Restore workspace layout' : 'Full screen terminal'}
            aria-label={`${isFullScreen ? 'Restore workspace layout from' : 'Full screen'} ${displayLabel}`}
            onClick={onFullScreen}
          >
            <Maximize2 size={12} />
          </button>
          <button
            className="icon-button new-pane-trigger"
            title="New agent"
            aria-label={`Open new agent menu from ${displayLabel}`}
            aria-haspopup="menu"
            aria-expanded={newPaneMenuOpen}
            onClick={onNewPane}
          >
            <Plus size={14} />
          </button>
          <button
            className="icon-button"
            title="Close terminal"
            aria-label={`Close ${displayLabel}`}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </header>
      )}
      <div
        className="terminal-host"
        style={{ '--terminal-bg': terminalTheme(preferences.theme, preferences.pluginTheme).background } as CSSProperties}
        onDragEnter={(event) => {
          if (!canDrop(event)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDropState('over');
        }}
        onDragOver={(event) => {
          if (!canDrop(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={() => {
          if (dropState !== 'over') return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDropState(null);
        }}
        onDrop={(event) => {
          if (canDrop(event)) void dropFiles(event);
        }}
      >
        <div className="terminal-surface" ref={host} />
        {dropState && (
          <div className={`terminal-drop-overlay ${dropState}`} role="status">
            {dropState === 'saving' ? <LoaderCircle size={18} className="spinning" /> : <ImagePlus size={18} />}
            <span>{dropState === 'saving' ? 'Adding to terminal…' : `Drop to add to ${displayLabel}`}</span>
          </div>
        )}
        {booting && (
          <div className="terminal-booting" role="status">
            <AgentLogo agentId={info.agentId} size={18} />
            <span>Starting {displayLabel.replace(/\s+\d+$/, '')}…</span>
          </div>
        )}
      </div>
    </section>
  );
}

/** True once output contains visible text, not just terminal control sequences. */
function hasReadableText(data: string) {
  const text = data
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '');
  return /[\p{L}\p{N}]/u.test(text);
}
