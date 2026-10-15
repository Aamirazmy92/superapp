import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Globe,
  History,
  Maximize2,
  Minimize2,
  Monitor,
  MousePointerClick,
  PanelsTopLeft,
  Plus,
  RotateCcw,
  Smartphone,
  Tablet,
  X,
} from './icons';
import { browserTarget, searchURL } from './browserAddress';
import BrowserHistory from './BrowserHistory';
import type { BrowserCommand } from './types';
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
const HOME_ADDRESS = 'http://localhost:3000';

type BrowserView = HTMLElement & {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  getWebContentsId(): number;
  setZoomFactor(factor: number): void;
  executeJavaScript(code: string): Promise<unknown>;
  reloadIgnoringCache(): void;
  stop(): void;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number;
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
};

// `url` is loaded as soon as the tab's view is ready (links opened in a new
// tab); a tab without one starts on the address bar.
type Tab = { id: number; title: string; url?: string; blank: boolean };

let nextTabId = 1;
const createTab = (url?: string, blank = false): Tab => ({ id: nextTabId++, title: url ?? 'New tab', url, blank });
// A page chosen from the history, to load in an existing tab.
type Navigation = { tabId: number; url: string; key: number };
let nextNavigationKey = 1;

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
  const [tabs, setTabs] = useState<Tab[]>(() => [createTab()]);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const [device, setDevice] = useState<DeviceMode>('responsive');
  // The active tab renders its page actions into the title bar.
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [navigation, setNavigation] = useState<Navigation | null>(null);

  // New tabs open next to the active one, as links opened in a new tab do.
  // Tabs opened from the history stay in the background, as in Chrome.
  function openTab(url?: string, activate = true) {
    const tab = createTab(url, !url);
    setTabs((current) => {
      const index = current.findIndex((item) => item.id === activeIdRef.current);
      return [...current.slice(0, index + 1), tab, ...current.slice(index + 1)];
    });
    if (activate) {
      setActiveId(tab.id);
      setHistoryOpen(false);
    }
  }
  function openFromHistory(url: string, newTab: boolean) {
    if (newTab) return openTab(url, false);
    setNavigation({ tabId: activeIdRef.current, url, key: nextNavigationKey++ });
    setHistoryOpen(false);
  }
  function closeTab(id: number) {
    // Closing the last tab closes the browser, which reopens on a new tab.
    if (tabs.length === 1) {
      const tab = createTab();
      setTabs([tab]);
      setActiveId(tab.id);
      return onClose();
    }
    const index = tabs.findIndex((tab) => tab.id === id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    setTabs(remaining);
    if (id === activeId) setActiveId(remaining[Math.min(index, remaining.length - 1)].id);
  }
  function setTitle(id: number, title: string) {
    setTabs((current) => current.map((tab) => (tab.id === id && tab.title !== title ? { ...tab, title } : tab)));
  }
  // Ctrl+Tab and Ctrl+Shift+Tab, wrapping around like Chrome.
  function cycleTab(step: 1 | -1) {
    const index = tabs.findIndex((tab) => tab.id === activeId);
    setActiveId(tabs[(index + step + tabs.length) % tabs.length].id);
  }

  // Pages asking for a new window (target="_blank", window.open) get a tab.
  useEffect(() => window.workspace?.onBrowserOpenTab((url) => openTab(url)), []);

  useEffect(() => {
    strip.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);

  return (
    <section
      className={`preview-panel workspace-browser${historyOpen ? ' history-open' : ''}`}
      aria-label="Browser"
      style={style}
      onKeyDown={(event) => {
        // Keys pressed inside a page stay in its view; these work from the
        // browser's own controls.
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const key = event.key.toLowerCase();
        if (key === 'tab') cycleTab(event.shiftKey ? -1 : 1);
        else if (event.shiftKey) return;
        else if (key === 't') openTab();
        else if (key === 'w') closeTab(activeId);
        else if (key === 'h') setHistoryOpen((open) => !open);
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
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
        <div ref={setActionsSlot} className="browser-tab-actions" />
        <button
          className="icon-button browser-history-toggle"
          aria-label="History"
          aria-pressed={historyOpen}
          title={historyOpen ? 'Close history' : 'History (Ctrl+H)'}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <History size={14} />
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
      <div className="editor-tabbar browser-tabbar">
        <div className="file-tabs" role="tablist" aria-label="Browser tabs" ref={strip}>
          {tabs.map((tab, index) => (
            <div className={`file-tab ${tab.id === activeId ? 'active' : ''}`} key={tab.id} role="presentation">
              <button
                role="tab"
                id={`browser-tab-${tab.id}`}
                aria-controls={`browser-tabpanel-${tab.id}`}
                aria-selected={tab.id === activeId}
                tabIndex={tab.id === activeId ? 0 : -1}
                title={tab.title}
                onClick={() => setActiveId(tab.id)}
                onAuxClick={(event) => { if (event.button === 1) closeTab(tab.id); }}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
                  else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = tabs.length - 1;
                  else if (event.key === 'Delete') {
                    event.preventDefault();
                    closeTab(tab.id);
                    return;
                  } else return;
                  event.preventDefault();
                  setActiveId(tabs[next].id);
                  strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                }}
              >
                <Globe size={12} />
                <span className="file-tab-label">{tab.title}</span>
              </button>
              <button aria-label={`Close tab ${tab.title}`} title="Close tab (Ctrl+W)" onClick={() => closeTab(tab.id)}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <button className="icon-button browser-new-tab" aria-label="New tab" title="New tab (Ctrl+T)" onClick={() => openTab()}>
          <Plus size={14} />
        </button>
      </div>
      {tabs.map((tab) => (
        <BrowserTab
          key={tab.id}
          id={tab.id}
          active={tab.id === activeId}
          initialURL={tab.url}
          blank={tab.blank}
          device={device}
          actionsSlot={actionsSlot}
          navigation={navigation?.tabId === tab.id ? navigation : undefined}
          onTitle={(title) => setTitle(tab.id, title)}
          onOpenTab={openTab}
          onToggleHistory={() => setHistoryOpen((open) => !open)}
          onCloseTab={() => closeTab(tab.id)}
          onCycleTab={cycleTab}
          onSendToAgent={onSendToAgent}
        />
      ))}
      {historyOpen && <BrowserHistory onOpen={openFromHistory} onClose={() => setHistoryOpen(false)} />}
    </section>
  );
}

// One page with its own view, history and element picker. Inactive tabs stay
// mounted (hidden) so their pages keep running and keep their place.
function BrowserTab({
  id,
  active,
  initialURL,
  blank,
  device,
  actionsSlot,
  navigation,
  onTitle,
  onOpenTab,
  onToggleHistory,
  onCloseTab,
  onCycleTab,
  onSendToAgent,
}: {
  id: number;
  active: boolean;
  initialURL?: string;
  blank: boolean;
  device: DeviceMode;
  actionsSlot: HTMLElement | null;
  navigation?: Navigation;
  onTitle(title: string): void;
  onOpenTab(url?: string): void;
  onToggleHistory(): void;
  onCloseTab(): void;
  onCycleTab(step: 1 | -1): void;
  onSendToAgent(prompt: string): Promise<void>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const [finding, setFinding] = useState(false);
  const [findText, setFindText] = useState('');
  const [findResult, setFindResult] = useState<{ active: number; matches: number } | null>(null);
  const view = useRef<BrowserView | null>(null);
  const [address, setAddress] = useState(initialURL ?? (blank ? '' : HOME_ADDRESS));
  const [currentURL, setCurrentURL] = useState('');
  const [ready, setReady] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const content = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState({ width: 0, height: 0 });
  const zoomFactor = useRef(1);
  const searchFallback = useRef<string | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [instruction, setInstruction] = useState('');
  const [sending, setSending] = useState(false);
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;

  function focusAddress() {
    addressInput.current?.focus();
    addressInput.current?.select();
  }
  // Find in page (Ctrl+F). Typing starts a new search; Enter and the arrows
  // step through its matches.
  function openFind() {
    setFinding(true);
    // Reopening highlights the last search again, as Chrome does.
    if (!finding && findText) find(findText);
    // The bar may not be rendered yet.
    requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
  }
  function find(text: string, forward = true, next = false) {
    const webview = view.current;
    if (!webview || !ready) return;
    if (!text) {
      webview.stopFindInPage('clearSelection');
      setFindResult(null);
      return;
    }
    webview.findInPage(text, { forward, findNext: !next });
  }
  function closeFind() {
    setFinding(false);
    setFindResult(null);
    if (ready) view.current?.stopFindInPage('keepSelection');
  }
  // What a shortcut or menu item chosen in this tab's page asks for.
  function runCommand(action: BrowserCommand, value?: string) {
    const webview = view.current;
    if (action === 'new-tab') onOpenTab();
    else if (action === 'close-tab') onCloseTab();
    else if (action === 'next-tab') onCycleTab(1);
    else if (action === 'previous-tab') onCycleTab(-1);
    else if (action === 'search' && value) onOpenTab(searchURL(value));
    else if (action === 'focus-address') focusAddress();
    else if (action === 'find') openFind();
    else if (action === 'history') onToggleHistory();
    else if (!webview || !ready) return;
    else if (action === 'reload') webview.reload();
    else if (action === 'hard-reload') webview.reloadIgnoringCache();
    else if (action === 'back' && webview.canGoBack()) webview.goBack();
    else if (action === 'forward' && webview.canGoForward()) webview.goForward();
  }
  const runCommandRef = useRef(runCommand);
  runCommandRef.current = runCommand;
  useEffect(() => {
    if (!ready || !window.workspace) return;
    const guestId = view.current?.getWebContentsId();
    return window.workspace.onBrowserCommand((target, action, value) => {
      if (target === guestId) runCommandRef.current(action, value);
    });
  }, [ready]);

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
    webview.setAttribute('partition', 'persist:veyo-browser');
    webview.setAttribute('src', 'about:blank');
    // Lets pages ask for new windows; electron/main.cjs denies each one and
    // opens it as a tab instead.
    webview.setAttribute('allowpopups', '');
    webview.className = 'workspace-browser-view';
    const sync = () => {
      // Zoom can be reset when a navigation changes origin.
      webview.setZoomFactor(zoomFactor.current);
      const url = webview.getURL();
      if (url && url !== 'about:blank') {
        setCurrentURL(url);
        setAddress(url);
        onTitleRef.current(webview.getTitle() || url);
      }
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    };
    let opened = false;
    const attached = () => {
      setReady(true);
      // A full navigation drops the page's picker and any selection.
      setPicked(null);
      if (pickingRef.current) void webview.executeJavaScript(PICKER_START_SCRIPT).catch(() => {});
      if (!opened && initialURL) void webview.loadURL(initialURL).catch(() => {});
      opened = true;
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
    const started = () => { setLoading(true); setMessage(''); };
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
    const titled = (event: Event) => {
      const title = (event as Event & { title?: string }).title;
      if (title) onTitleRef.current(title);
    };
    webview.addEventListener('dom-ready', attached);
    webview.addEventListener('console-message', consoleMessage);
    webview.addEventListener('did-start-loading', started);
    webview.addEventListener('did-stop-loading', stopped);
    webview.addEventListener('did-navigate', () => { searchFallback.current = undefined; setFindResult(null); sync(); });
    webview.addEventListener('did-navigate-in-page', sync);
    webview.addEventListener('did-fail-load', failed);
    webview.addEventListener('page-title-updated', titled);
    webview.addEventListener('found-in-page', (event) => {
      const { activeMatchOrdinal, matches } = (event as Event & {
        result: { activeMatchOrdinal: number; matches: number };
      }).result;
      setFindResult({ active: activeMatchOrdinal, matches });
    });
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

  // A page chosen from the history loads here once the view is ready.
  const navigated = useRef(0);
  useEffect(() => {
    const webview = view.current;
    if (!ready || !webview || !navigation || navigated.current === navigation.key) return;
    navigated.current = navigation.key;
    searchFallback.current = undefined;
    setAddress(navigation.url);
    setMessage('');
    void webview.loadURL(navigation.url).catch(() => {});
  }, [ready, navigation]);

  // Clearing browsing data empties every tab's back and forward list.
  useEffect(() => {
    const webview = view.current;
    if (!ready || !webview || !window.workspace) return;
    return window.workspace.onBrowserHistoryChanged(() => {
      if (view.current !== webview) return;
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    });
  }, [ready]);

  const actions = (
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
  );

  return (
    <div
      className="browser-tab-page"
      role="tabpanel"
      id={`browser-tabpanel-${id}`}
      aria-labelledby={`browser-tab-${id}`}
      hidden={!active}
      onKeyDown={(event) => {
        // The same shortcuts as inside the page, from the browser's controls.
        const mod = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
        const key = event.key.toLowerCase();
        if (mod && key === 'f') openFind();
        else if ((mod && key === 'l') || event.key === 'F6') focusAddress();
        else if (event.key === 'F5' && currentURL) {
          if (event.ctrlKey || event.shiftKey) view.current?.reloadIgnoringCache();
          else view.current?.reload();
        } else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {active && actionsSlot && createPortal(actions, actionsSlot)}
      <form className="preview-address browser-address" onSubmit={(event) => { event.preventDefault(); void navigate(); }}>
        <button type="button" className="icon-button" aria-label="Back" title="Back" disabled={!canGoBack} onClick={() => view.current?.goBack()}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" className="icon-button" aria-label="Forward" title="Forward" disabled={!canGoForward} onClick={() => view.current?.goForward()}>
          <ArrowRight size={15} />
        </button>
        {loading ? (
          <button type="button" className="icon-button" aria-label="Stop loading" title="Stop loading this page" onClick={() => view.current?.stop()}>
            <X size={15} />
          </button>
        ) : (
          <button type="button" className="icon-button" aria-label="Reload page" title="Reload page (F5)" disabled={!currentURL} onClick={() => view.current?.reload()}>
            <RotateCcw size={14} />
          </button>
        )}
        <input ref={addressInput} autoFocus={blank} aria-label="Browser address" placeholder="Search Google or enter an address" value={address} spellCheck={false} onChange={(event) => setAddress(event.target.value)} onFocus={(event) => event.currentTarget.select()} />
        <button type="submit" className="browser-go" disabled={!ready}>Go</button>
      </form>
      {message && <div className="browser-error" role="alert">{message}</div>}
      {finding && (
        <div className="browser-find-bar" role="search" aria-label="Find in page">
          <input
            ref={findInput}
            aria-label="Find in page"
            placeholder="Find in page"
            value={findText}
            spellCheck={false}
            onChange={(event) => { setFindText(event.target.value); find(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); find(findText, !event.shiftKey, true); }
              else if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
            }}
          />
          <span className="browser-find-count" aria-live="polite">
            {findText && findResult ? `${findResult.active}/${findResult.matches}` : ''}
          </span>
          <button type="button" className="icon-button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!findResult?.matches} onClick={() => find(findText, false, true)}>
            <ArrowUp size={14} />
          </button>
          <button type="button" className="icon-button" aria-label="Next match" title="Next match (Enter)" disabled={!findResult?.matches} onClick={() => find(findText, true, true)}>
            <ArrowDown size={14} />
          </button>
          <button type="button" className="icon-button" aria-label="Close find bar" title="Close (Esc)" onClick={closeFind}>
            <X size={14} />
          </button>
        </div>
      )}
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
    </div>
  );
}
