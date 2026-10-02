import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Maximize2,
  Minimize2,
  Monitor,
  MousePointerClick,
  PanelsTopLeft,
  RotateCcw,
  Smartphone,
  Tablet,
  Trash2,
  X,
} from 'lucide-react';
import { browserTarget } from './browserAddress';
import {
  PICKER_RESET_SCRIPT,
  PICKER_START_SCRIPT,
  PICKER_STOP_SCRIPT,
  buildPickPrompt,
  parsePickMessage,
  type PickedElement,
} from './elementPicker';

type DeviceMode = 'responsive' | 'mobile' | 'tablet' | 'desktop';

// Viewport sizes in CSS pixels; electron/main.cjs holds the matching user
// agents and touch settings for each mode.
const DEVICES = {
  responsive: { label: 'Fit to panel', icon: PanelsTopLeft, width: 0, height: 0 },
  mobile: { label: 'Mobile', icon: Smartphone, width: 412, height: 915 },
  tablet: { label: 'Tablet', icon: Tablet, width: 800, height: 1280 },
  desktop: { label: 'Windows PC', icon: Monitor, width: 1366, height: 768 },
} as const;
const DEVICE_MODES = Object.keys(DEVICES) as DeviceMode[];
// Keep in sync with .workspace-browser-content.device-mode in design.css.
const DEVICE_GUTTER = 12;
const DEVICE_LABEL_HEIGHT = 26;
// Chromium's smallest page zoom; below it the frame scrolls instead.
const MIN_ZOOM = 0.25;
// Chromium's DNS failures: the typed host name doesn't exist.
const NAME_NOT_RESOLVED = [-105, -137];

type BrowserView = HTMLElement & {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  getWebContentsId(): number;
  setZoomFactor(factor: number): void;
  executeJavaScript(code: string): Promise<unknown>;
};

export default function WorkspaceBrowser({
  isFullscreen,
  style,
  onClose,
  onToggleFullscreen,
  onSendToAgent,
}: {
  isFullscreen: boolean;
  style?: React.CSSProperties;
  onClose(): void;
  onToggleFullscreen(): void;
  // Hands a change request to the active agent; rejects with a user-facing
  // message when there is no agent to take it.
  onSendToAgent(prompt: string): Promise<void>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<BrowserView | null>(null);
  const [address, setAddress] = useState('http://localhost:3000');
  const [currentURL, setCurrentURL] = useState('');
  const [ready, setReady] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [historyStatus, setHistoryStatus] = useState('');
  const [clearingHistory, setClearingHistory] = useState(false);
  const historyPending = useRef(false);
  const [device, setDevice] = useState<DeviceMode>('responsive');
  const content = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState({ width: 0, height: 0 });
  const zoomFactor = useRef(1);
  const searchFallback = useRef<string | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [instruction, setInstruction] = useState('');
  const [sending, setSending] = useState(false);

  // The page runs the picker; these only start and stop it. A page that has
  // navigated away has no picker left to stop, so failures are ignored.
  function runInPage(script: string) {
    return view.current?.executeJavaScript(script).catch(() => {});
  }
  function stopPicking() {
    pickingRef.current = false;
    setPicking(false);
    setPicked(null);
    setInstruction('');
    void runInPage(PICKER_STOP_SCRIPT);
  }
  function togglePicking() {
    if (pickingRef.current) return stopPicking();
    pickingRef.current = true;
    setPicking(true);
    setMessage('');
    void runInPage(PICKER_START_SCRIPT);
  }
  function pickAnother() {
    setPicked(null);
    setInstruction('');
    void runInPage(PICKER_RESET_SCRIPT);
  }
  async function sendChange() {
    if (!picked || !instruction.trim() || sending) return;
    setSending(true);
    setMessage('');
    try {
      await onSendToAgent(buildPickPrompt(picked, instruction));
      stopPicking();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (!host.current) return;
    const webview = document.createElement('webview') as BrowserView;
    webview.setAttribute('partition', 'persist:superapp-browser');
    webview.setAttribute('src', 'about:blank');
    webview.className = 'workspace-browser-view';
    const sync = () => {
      // Zoom can be reset when a navigation changes origin.
      webview.setZoomFactor(zoomFactor.current);
      const url = webview.getURL();
      if (url && url !== 'about:blank') {
        setCurrentURL(url);
        setAddress(url);
      }
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    };
    const attached = () => {
      setReady(true);
      // A full navigation drops the page's picker and any selection.
      setPicked(null);
      if (pickingRef.current) void webview.executeJavaScript(PICKER_START_SCRIPT).catch(() => {});
    };
    const consoleMessage = (event: Event) => {
      const pick = parsePickMessage((event as Event & { message?: string }).message ?? '');
      if (!pick || !pickingRef.current) return;
      if (pick.type === 'cancel') {
        pickingRef.current = false;
        setPicking(false);
        setPicked(null);
        setInstruction('');
        void webview.executeJavaScript(PICKER_STOP_SCRIPT).catch(() => {});
      } else {
        setPicked(pick.element);
      }
    };
    const started = () => { setLoading(true); setMessage(''); setHistoryStatus(''); };
    const stopped = () => { setLoading(false); sync(); };
    const failed = (event: Event) => {
      const failure = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
      if (!failure.isMainFrame || failure.errorCode === -3) return;
      const fallback = searchFallback.current;
      searchFallback.current = undefined;
      if (fallback && NAME_NOT_RESOLVED.includes(failure.errorCode ?? 0)) {
        setAddress(fallback);
        void webview.loadURL(fallback).catch(() => {});
        return;
      }
      setMessage(failure.errorDescription || 'The page could not be loaded.');
    };
    webview.addEventListener('dom-ready', attached);
    webview.addEventListener('console-message', consoleMessage);
    webview.addEventListener('did-start-loading', started);
    webview.addEventListener('did-stop-loading', stopped);
    webview.addEventListener('did-navigate', () => { searchFallback.current = undefined; sync(); });
    webview.addEventListener('did-navigate-in-page', () => { setHistoryStatus(''); sync(); });
    webview.addEventListener('did-fail-load', failed);
    host.current.appendChild(webview);
    view.current = webview;
    return () => { view.current = null; webview.remove(); };
  }, []);

  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSpace({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const frame = DEVICES[device];
  // The frame takes the size it is shown at and the page is zoomed out to
  // fill it, so Chromium draws text and images at their final size. (Scaling
  // a full-size page down with CSS shrinks a finished image and blurs it.)
  // Width is snapped to whole device pixels so the page sees the exact
  // viewport width.
  const pixelRatio = window.devicePixelRatio || 1;
  const fit = device === 'responsive' || !space.width || !space.height
    ? 1
    : Math.max(MIN_ZOOM, Math.min(1,
      (space.width - DEVICE_GUTTER * 2) / frame.width,
      (space.height - DEVICE_GUTTER * 2 - DEVICE_LABEL_HEIGHT) / frame.height));
  const frameWidth = Math.round(frame.width * fit * pixelRatio) / pixelRatio;
  const zoom = device === 'responsive' ? 1 : frameWidth / frame.width;
  const frameHeight = Math.round(frame.height * zoom * pixelRatio) / pixelRatio;

  useEffect(() => {
    zoomFactor.current = zoom;
    if (ready) view.current?.setZoomFactor(zoom);
  }, [ready, zoom]);

  useEffect(() => {
    const webview = view.current;
    if (!ready || !webview || !window.workspace) return;
    let cancelled = false;
    window.workspace.setBrowserDevice(webview.getWebContentsId(), device)
      .then(() => {
        // Servers read the user agent per request, so reload to get the
        // markup they serve this device.
        if (!cancelled && webview.getURL() !== 'about:blank') webview.reload();
      })
      .catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [ready, device]);

  async function navigate() {
    try {
      const { url, fallback } = browserTarget(address);
      setAddress(url);
      setMessage('');
      searchFallback.current = fallback;
      await view.current?.loadURL(url);
    } catch (error) {
      // A failed load is reported through did-fail-load, which also handles
      // the search fallback; only address errors are shown from here.
      if (!(error instanceof Error && /ERR_/.test(error.message)))
        setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function clearHistory() {
    const webview = view.current;
    if (!ready || loading || historyPending.current || !webview || !window.workspace) return;
    historyPending.current = true;
    setClearingHistory(true);
    setHistoryStatus('');
    setMessage('');
    try {
      await window.workspace.clearBrowserHistory(webview.getWebContentsId());
      if (view.current !== webview) return;
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
      setHistoryStatus('Browsing history cleared. Current page and site sign-ins kept.');
    } catch (error) {
      if (view.current === webview)
        setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      historyPending.current = false;
      if (view.current === webview) setClearingHistory(false);
    }
  }

  return (
    <section className="preview-panel workspace-browser" aria-label="Browser" style={style}>
      <div className="preview-title">
        <Globe size={14} />
        Browser
        <div className="browser-device-switch" role="radiogroup" aria-label="Device mode">
          {DEVICE_MODES.map((mode) => {
            const { label, icon: Icon, width, height } = DEVICES[mode];
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                className="icon-button"
                aria-checked={device === mode}
                aria-label={label}
                title={width ? `${label} (${width} × ${height})` : label}
                onClick={() => setDevice(mode)}
              >
                <Icon size={14} />
              </button>
            );
          })}
        </div>
        <button
          className="icon-button browser-pick-toggle"
          aria-label="Select an element to edit"
          aria-pressed={picking}
          title={picking ? 'Stop selecting' : 'Select an element on the page and ask for a change'}
          disabled={!ready || !currentURL}
          onClick={togglePicking}
        >
          <MousePointerClick size={14} />
        </button>
        <button
          className="icon-button browser-clear-history"
          aria-label="Clear browsing history"
          title={clearingHistory ? 'Clearing browsing history…' : 'Clear browsing history (keeps the current page and site sign-ins)'}
          aria-busy={clearingHistory}
          disabled={!ready || loading || clearingHistory}
          onClick={() => void clearHistory()}
        >
          <Trash2 size={14} />
        </button>
        <button
          className="icon-button browser-expand-toggle"
          aria-label={isFullscreen ? 'Restore browser panel' : 'Expand browser'}
          aria-pressed={isFullscreen}
          title={isFullscreen ? 'Restore browser panel' : 'Expand browser'}
          onClick={onToggleFullscreen}
        >
          {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button className="icon-button" aria-label="Close browser" title="Close browser" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <form className="preview-address browser-address" onSubmit={(event) => { event.preventDefault(); void navigate(); }}>
        <button type="button" className="icon-button" aria-label="Back" title="Back" disabled={!canGoBack} onClick={() => view.current?.goBack()}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" className="icon-button" aria-label="Forward" title="Forward" disabled={!canGoForward} onClick={() => view.current?.goForward()}>
          <ArrowRight size={15} />
        </button>
        <button type="button" className="icon-button" aria-label="Reload page" title="Reload page" disabled={!currentURL} onClick={() => view.current?.reload()}>
          <RotateCcw size={14} className={loading ? 'spinning' : undefined} />
        </button>
        <input aria-label="Browser address" placeholder="Search Google or enter an address" value={address} spellCheck={false} onChange={(event) => setAddress(event.target.value)} onFocus={(event) => event.currentTarget.select()} />
        <button type="submit" className="browser-go" disabled={!ready}>Go</button>
      </form>
      {message && <div className="browser-error" role="alert">{message}</div>}
      {historyStatus && <div className="browser-status" role="status">{historyStatus}</div>}
      <div ref={content} className={`workspace-browser-content${device === 'responsive' ? '' : ' device-mode'}`}>
        <div
          className="workspace-browser-frame"
          style={{
            display: currentURL ? undefined : 'none',
            ...(device !== 'responsive' && { flex: 'none', width: frameWidth, height: frameHeight }),
          }}
        >
          <div ref={host} className="workspace-browser-host" />
        </div>
        {currentURL && device !== 'responsive' && (
          <div className="browser-device-label">
            {frame.label} · {frame.width} × {frame.height} · {Math.round(zoom * 100)}%
          </div>
        )}
        {!currentURL && (
          <div className="preview-empty">
            <Globe size={28} />
            <p>Run your app, then enter its local address above.</p>
            <span>Or search Google and browse HTTPS sites while you work.</span>
          </div>
        )}
      </div>
      {picking && (
        <form
          className="browser-pick-bar"
          aria-label="Ask for a change to the selected element"
          onSubmit={(event) => { event.preventDefault(); void sendChange(); }}
          onKeyDown={(event) => { if (event.key === 'Escape') stopPicking(); }}
        >
          {picked ? (
            <>
              <code className="browser-pick-target" title={picked.selector}>{picked.selector}</code>
              <input
                autoFocus
                aria-label="Describe the change"
                placeholder="What should change? e.g. make this larger and blue"
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
              />
              <button type="submit" className="browser-go" disabled={!instruction.trim() || sending}>Send</button>
              <button type="button" className="icon-button" aria-label="Pick a different element" title="Pick a different element" onClick={pickAnother}>
                <X size={14} />
              </button>
            </>
          ) : (
            <span className="browser-pick-hint">Hover the page and click an element to edit it. Esc to stop.</span>
          )}
        </form>
      )}
    </section>
  );
}
