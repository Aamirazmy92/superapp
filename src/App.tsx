import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
// Chat and the editor are loaded by hand rather than with lazy(): a lazy
// component suspends on its first render even when its chunk is cached, and
// React then holds the fallback for ~300ms, so the first switch to Chat
// flashed an empty screen and the first file flashed a loading message.
let chatModule: typeof import('./ChatWorkspace') | null = null;
const loadChat = () => import('./ChatWorkspace').then((module) => (chatModule = module));
let editorModule: typeof import('./EditorSurfaces') | null = null;
const loadEditor = () => import('./EditorSurfaces').then((module) => (editorModule = module));
// Plugins carries the Markdown renderer, so it stays out of the startup bundle.
let pluginsModule: typeof import('./Plugins') | null = null;
const loadPlugins = () => import('./Plugins').then((module) => (pluginsModule = module));
import veyoIcon from './assets/brand/veyo-icon.png';
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  Pin,
  Code2,
  Menu,
  MessageSquare,
  Files,
  PanelLeft,
  FolderOpen,
  SlidersHorizontal,
  GitBranch,
  LayoutDashboard,
  Minus,
  PanelBottom,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SettingsGear,
  Square,
  SquareTerminal,
  X,
  Zap,
  AlertCircle,
  Archive,
  ArchiveRestore,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  FolderInput,
  PinOff,
  Globe,
  Trash2,
  Play,
  FileText,
} from './icons';
import FileTabs from './FileTabs';
import Modal from './Modal';
import { editorPath } from './editorModel';
import TerminalPane from './TerminalPane';
import { useTerminalReorder } from './useTerminalReorder';
import Settings from './Settings';
import { usePreferences } from './preferences';
import { playDoneSound } from './doneSound';
import AgentLauncher from './AgentLauncher';
import AgentPicker from './AgentPicker';
import AgentDashboard from './AgentDashboard';
import { useUsage } from './useUsage';
import {
  agentTurnSettlesAt,
  terminalStatus,
  recordAgentKeystroke,
  recordAgentOutput,
  settleAgentTurn,
  type AgentTurn as AgentTurnState,
} from './agentTurn';
import { AnimatePresence, MotionConfig, motion, useMotionValue } from 'motion/react';
import {
  Backdrop,
  MotionDialog,
  Surface,
  isClosing,
  motionReduced,
  surfaceMotion,
  useCollapse,
  usePressSprings,
  useViewSwitch,
} from './motion';
import { AnchoredPopover } from './AnchoredPopover';
import NewPaneMenu, { prefetchPaneAgents } from './NewPaneMenu';
import ProjectTools from './ProjectTools';
import QuickOpen from './QuickOpen';
import WorkspaceBrowser from './WorkspaceBrowser';
import RunCommands from './RunCommands';
import PluginPrompt from './PluginPrompt';
import { usePluginContributions } from './usePlugins';
import { pluginTheme, pluginThemeTokens, setPluginThemes } from './themes';
import { errorMessage as pluginError, terminalPaste } from './pluginModel';
import type { PluginContributions } from './types';
import { useNotifications } from './Notifications';
import CommandPalette, { type PaletteCommand } from './CommandPalette';
import { usePanelWidths } from './usePanelWidths';
import {
  displayTerminalLabel,
  displayTerminalTitle,
  isAgentContextReset,
  stripTerminalControls,
  summarizeAgentPrompt,
  summarizeShellCommands,
} from './sessionTitle';
import {
  agentSelectionsFor,
  baseName,
  emptyGit,
  language,
  newWork,
  sessionFor,
  toastIsError,
  withoutKey,
  workspaceGroups,
  workspaceSections,
  type Work,
} from './workspaceModel';
import type {
  Bootstrap,
  GitStatus,
  Layout,
  OpenFile,
  Project,
  AgentSelection,
  TerminalInfo,
  WorkspaceMeta,
} from './types';

type ConfirmRequest = {
  message: string;
  detail: string;
  action: string;
  resolve: (confirmed: boolean) => void;
};
type AgentTurn = AgentTurnState & {
  timer?: ReturnType<typeof setTimeout>;
};
export default function App() {
  const api = window.workspace;
  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const workAreaRef = useRef<HTMLDivElement>(null);
  const projectsPanelRef = useRef<HTMLElement>(null);
  const explorerPanelRef = useRef<HTMLElement>(null);
  const dashboardDocked = window.innerWidth > 1080;
  const dashboardDrawerMotionWidth = useMotionValue(0);
  const {
    panelWidths,
    dashboardDrawerWidth,
    browserContainerWidth,
    browserPanelWidth,
    browserPanelMinWidth,
    panelSeparator,
  } = usePanelWidths({
    projectsPanelRef,
    explorerPanelRef,
    workspaceRef,
    workAreaRef,
    dashboardDrawerMotionWidth,
    onDashboardResizeStart: () => settleDashboardLayout(),
  });
  useEffect(
    () => () => {
      document.body.classList.remove(
        'panel-resizing',
        'row-resizing',
        'dashboard-layout-transitioning',
      );
    },
    [],
  );
  const [revealTarget, setRevealTarget] = useState<{
    path: string;
    line: number;
    column: number;
  } | null>(null);
  const [mode, setMode] = useState<'code' | 'chat'>('code');
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const previousDashboardOpen = useRef(dashboardOpen);
  // While the docked dashboard animates, terminals are laid out for the width
  // the work area will end at, so the grid and terminal text change once, up
  // front, and only the pane edges move during the animation.
  const [dashboardLayoutTarget, setDashboardLayoutTarget] = useState<{
    open: boolean;
    workAreaWidth: number;
  } | null>(null);
  // Briefly puts the drawer at its final width so `measure` sees the settled
  // layout, then restores it before the browser paints.
  function withSettledDashboardLayout<T>(open: boolean, measure: () => T): T | undefined {
    const drawer = appBodyRef.current?.querySelector<HTMLElement>('.dashboard-drawer.docked');
    if (!drawer) return undefined;
    const width = drawer.style.width;
    drawer.style.width = open ? `${dashboardDrawerWidth}px` : '0px';
    try {
      return measure();
    } finally {
      drawer.style.width = width;
    }
  }
  useLayoutEffect(() => {
    if (previousDashboardOpen.current === dashboardOpen) return;
    previousDashboardOpen.current = dashboardOpen;
    if (!dashboardDocked || motionReduced()) return;
    document.body.classList.add('dashboard-layout-transitioning');
    const workAreaWidth = withSettledDashboardLayout(
      dashboardOpen,
      () => workAreaRef.current?.getBoundingClientRect().width,
    );
    if (workAreaWidth) setDashboardLayoutTarget({ open: dashboardOpen, workAreaWidth });
  }, [dashboardOpen, dashboardDocked]);
  useLayoutEffect(() => {
    if (!dashboardLayoutTarget) return;
    // The grid has re-rendered for the target width; let terminals fit to it.
    withSettledDashboardLayout(dashboardLayoutTarget.open, () =>
      window.dispatchEvent(new Event('dashboard-layout-preview')),
    );
  }, [dashboardLayoutTarget]);
  const settleDashboardLayout = () => {
    if (!document.body.classList.contains('dashboard-layout-transitioning')) return;
    document.body.classList.remove('dashboard-layout-transitioning');
    setDashboardLayoutTarget(null);
    window.dispatchEvent(new Event('dashboard-layout-settled'));
  };
  const [chatVisited, setChatVisited] = useState(false);
  const [chatHandoff, setChatHandoff] = useState<{
    id: string;
    projectId: string;
    draft: string;
    attachActiveFile: boolean;
  } | null>(null);
  // Switch only once the chat module is ready (already, after the idle
  // preload), so the code view never gives way to an empty screen.
  function openChat() {
    loadChat().then(
      () => {
        setChatVisited(true);
        setMode('chat');
      },
      (error) => setToast(`Could not open chat: ${String(error)}`),
    );
  }
  useEffect(() => {
    const id = requestIdleCallback(() => {
      // Mount chat hidden so its saved state and model list are ready before the first switch.
      void loadChat().then(() => setChatVisited(true)).catch(() => {});
      void loadEditor().catch(() => {});
      void loadPlugins().catch(() => {});
    });
    return () => cancelIdleCallback(id);
  }, []);
  const [explorer, setExplorer] = useState(false);
  // The chat Files pane opens from the title bar like Claude Code's; remembered across launches.
  const [chatFilesOpen, setChatFilesOpen] = useState(() => {
    try {
      return localStorage.getItem('chat-files') === 'open';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('chat-files', chatFilesOpen ? 'open' : 'closed');
    } catch {}
  }, [chatFilesOpen]);
  // The chat draws its title and actions into the title bar, so the title bar hands it this slot.
  const [chatSlot, setChatSlot] = useState<HTMLDivElement | null>(null);
  const [chatTerminalOpen, setChatTerminalOpen] = useState(() => {
    try {
      return localStorage.getItem('chat-terminal') === 'open';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('chat-terminal', chatTerminalOpen ? 'open' : 'closed');
    } catch {}
  }, [chatTerminalOpen]);
  const [chatBrowserOpen, setChatBrowserOpen] = useState(() => {
    try {
      return localStorage.getItem('chat-browser') === 'open';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('chat-browser', chatBrowserOpen ? 'open' : 'closed');
    } catch {}
  }, [chatBrowserOpen]);
  const [projectsPanel, setProjectsPanel] = useState(() => {
    try {
      return localStorage.getItem('code-projects-panel') !== 'minimised';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('code-projects-panel', projectsPanel ? 'open' : 'minimised');
    } catch {}
  }, [projectsPanel]);
  // Chat's conversation list hides from the same title bar button, remembered separately.
  const [chatSidebar, setChatSidebar] = useState(() => {
    try {
      return localStorage.getItem('chat-sidebar') !== 'minimised';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('chat-sidebar', chatSidebar ? 'open' : 'minimised');
    } catch {}
  }, [chatSidebar]);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Record<string, Work>>({});
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Record<string, boolean>>({});
  const [section, setSection] = useState<'files' | 'search' | 'git'>('files');
  const [refresh, setRefresh] = useState(0);
  const [git, setGit] = useState<GitStatus>(emptyGit);
  const [toast, setToast] = useState('');
  // An action (e.g. Undo) belongs to one specific toast message.
  const [toastAction, setToastAction] = useState<{
    text: string;
    label: string;
    run: () => void;
  } | null>(null);
  const { items: notifications, setItems: setNotifications, push: pushNotification } =
    useNotifications();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [closingFile, setClosingFile] = useState<{ projectId: string; path: string } | null>(null);
  const savingFile = useRef(false);
  const [palette, setPalette] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [agentLauncher, setAgentLauncher] = useState(false);
  const [newPaneMenu, setNewPaneMenu] = useState<{
    trigger: string;
    anchor: HTMLButtonElement;
  } | null>(null);
  const [runCommands, setRunCommands] = useState(false);
  const [settings, setSettings] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [, setPluginsLoaded] = useState(false);
  useEffect(() => {
    if (!pluginsOpen || pluginsModule) return;
    loadPlugins().then(
      () => setPluginsLoaded(true),
      (error) => {
        setPluginsOpen(false);
        setToast(`Could not open plugins: ${String(error)}`);
      },
    );
  }, [pluginsOpen]);
  const [pluginPrompt, setPluginPrompt] = useState<PluginContributions['prompts'][number] | null>(null);
  const { preferences, update: updatePreferences, saveError: preferencesError } = usePreferences();
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  usePressSprings();
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', preferences.reduceMotion);
  }, [preferences.reduceMotion]);
  const chatModeRef = useRef<HTMLDivElement>(null);
  const appBodyRef = useRef<HTMLDivElement>(null);
  const shownMode = useViewSwitch(mode, ['code', 'chat'] as const, (view) =>
    view === 'chat' ? chatModeRef.current : appBodyRef.current,
  );
  const explorerHidden = useCollapse(() => explorerPanelRef.current, explorer);
  const projectsHidden = useCollapse(() => projectsPanelRef.current, projectsPanel);
  // The title bar's leading cluster spans the code sidebar, so the title lines up with the content.
  useEffect(() => {
    const panel = projectsPanelRef.current;
    if (!panel) return;
    const explorerPanel = explorerPanelRef.current;
    const publish = () => {
      document.documentElement.style.setProperty('--code-sidebar-w', `${Math.round(panel.getBoundingClientRect().width)}px`);
      // A dashboard stacked under the explorer takes the explorer's width.
      if (explorerPanel)
        document.documentElement.style.setProperty('--explorer-w', `${Math.round(explorerPanel.getBoundingClientRect().width)}px`);
    };
    const observer = new ResizeObserver(publish);
    observer.observe(panel);
    if (explorerPanel) observer.observe(explorerPanel);
    publish();
    return () => observer.disconnect();
  }, []);
  const [workspaceRename, setWorkspaceRename] = useState<{
    projectId: string;
    name: string;
    value: string;
  } | null>(null);
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState<string | null>(null);
  // Dragging a workspace row onto a group heading moves it into that group.
  const [dragWorkspace, setDragWorkspace] = useState<{ projectId: string; name: string } | null>(null);
  const [dropSection, setDropSection] = useState<string | null>(null);
  // The workspace menu's "Move to group" step replaces the menu in place.
  const [workspaceMenuView, setWorkspaceMenuView] = useState<'main' | 'groups'>('main');
  const [groupPrompt, setGroupPrompt] = useState<{
    projectId: string;
    name: string;
    value: string;
  } | null>(null);
  const [showArchived, setShowArchived] = useState<Record<string, boolean>>({});
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  // The browser stays mounted once opened, so closing it only hides it and
  // its tabs and pages survive; a new session starts it afresh.
  const [browserSession, setBrowserSession] = useState(0);
  const [browserMounted, setBrowserMounted] = useState(false);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [fullScreenTerminalId, setFullScreenTerminalId] = useState<string | null>(null);
  const [beacon, setBeacon] = useState<{ id: string; nonce: number } | null>(null);
  const beaconTimer = useRef<number | undefined>(undefined);
  const terminalGridRef = useRef<HTMLDivElement>(null);
  const project = projects.find((p) => p.id === activeProject);
  const orderedProjects = [...projects].sort(
    (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)),
  );
  const work = activeProject ? workspaces[activeProject] : undefined;
  const workspaceName = work?.activeWorkspace || 'Main';
  const terminalsForWorkspace = (name: string) =>
    work?.terminals.filter((t) => (t.workspaceName || 'Main') === name) || [];
  const visibleTerminals = terminalsForWorkspace(workspaceName);
  const pluginContributions = usePluginContributions(project?.id);
  // Plugin themes are registered during render so the terminal and editor below
  // see the same set. A theme whose plugin is gone falls back to the built-in one.
  useMemo(
    () =>
      setPluginThemes(
        pluginContributions.themes.map((theme) => ({ key: theme.key, label: theme.label, plugin: theme.plugin, base: theme.base, colors: theme.colors })),
      ),
    [pluginContributions.themes],
  );
  const activePluginTheme = pluginTheme(preferences.pluginTheme);
  const displayPreferences = useMemo(
    () => (activePluginTheme || !preferences.pluginTheme ? preferences : { ...preferences, pluginTheme: '' }),
    [preferences, activePluginTheme],
  );
  const appliedThemeTokens = useRef<string[]>([]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = activePluginTheme?.base ?? preferences.theme;
    for (const name of appliedThemeTokens.current) root.style.removeProperty(name);
    const tokens = activePluginTheme ? pluginThemeTokens(activePluginTheme) : {};
    for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
    appliedThemeTokens.current = Object.keys(tokens);
  }, [preferences.theme, activePluginTheme]);
  // The agent a plugin prompt would be typed into: the focused one, else the newest.
  const promptAgents = visibleTerminals.filter((t) => !!t.agentId && t.agentId !== 'terminal' && !t.exited);
  const promptTarget = promptAgents.find((t) => t.id === activeTerminalId) ?? promptAgents.at(-1);
  const runningAgentCount =Object.values(workspaces).reduce(
    (sum, session) => sum + (session?.terminals.filter((t) => !t.exited).length || 0),
    0,
  );
  const showTerminalSection =
    work?.layout === 'terminal' ||
    (work?.layout === 'build' && visibleTerminals.length > 0);
  const fullScreenTerminalVisible = visibleTerminals.some((t) => t.id === fullScreenTerminalId);
  const reorder = useTerminalReorder({
    gridRef: terminalGridRef,
    ids: visibleTerminals.map((t) => t.id),
    enabled: !fullScreenTerminalId && visibleTerminals.length > 1,
    onCommit: commitTerminalOrder,
  });
  const draggingTerminalId = reorder.draggingId;
  const liveTerminalOrder = reorder.order;
  const terminalViews =
    fullScreenTerminalId && fullScreenTerminalVisible
      ? visibleTerminals.filter((t) => t.id === fullScreenTerminalId)
      : liveTerminalOrder
        ? [...visibleTerminals].sort(
            (a, b) => liveTerminalOrder.indexOf(a.id) - liveTerminalOrder.indexOf(b.id),
          )
        : visibleTerminals;
  const terminalAreaWidth = Math.max(
    0,
    (dashboardLayoutTarget?.workAreaWidth ?? browserContainerWidth) -
      (browserOpen && !browserFullscreen ? browserPanelWidth + 6 : 0),
  );
  // The browser is shown when opened and hidden once it has slid away.
  const browserHidden = useCollapse(
    () => workAreaRef.current?.querySelector<HTMLElement>('.workspace-browser') ?? null,
    browserOpen,
    { anchor: 'end', instant: browserFullscreen },
  );
  const maxTerminalColumns =
    terminalAreaWidth >= 960 ? 3 : terminalAreaWidth >= 620 ? 2 : 1;
  const terminalColumnCount = Math.min(terminalViews.length, maxTerminalColumns);
  const terminalGridRemainder = terminalColumnCount
    ? terminalViews.length % terminalColumnCount
    : 0;
  const terminalGridTrackCount = terminalColumnCount * (work?.layout === 'terminal' ? 2 : 1);
  const terminalGridLastRowStart = terminalViews.length - terminalGridRemainder;
  const draggingTerminal = visibleTerminals.find((t) => t.id === draggingTerminalId);
  const savedTerminals =
    work?.terminalPresets?.filter((t) => (t.workspaceName || 'Main') === workspaceName) || [];
  const reusablePresetTerminals = (() => {
    if (savedTerminals.length) return savedTerminals;
    const otherWorkspaceNames = [...(work?.workspaceNames || ['Main'])]
      .reverse()
      .filter((name) => name !== workspaceName);
    for (const name of otherWorkspaceNames) {
      const live = terminalsForWorkspace(name).filter((terminal) => !terminal.exited);
      if (live.length) return live;
      const saved =
        work?.terminalPresets?.filter((preset) => (preset.workspaceName || 'Main') === name) || [];
      if (saved.length) return saved;
    }
    return [];
  })();
  const reusablePresetSelections = agentSelectionsFor(reusablePresetTerminals);
  const file = work?.files.find((f) => f.path === work.activeFile);
  const [editorReady, setEditorReady] = useState(() => !!editorModule);
  useEffect(() => {
    editorModule?.releaseClosedEditorModels(
      Object.entries(workspaces).flatMap(([id, work]) =>
        work.files.map((item) => editorPath(id, item.path)),
      ),
    );
  }, [workspaces]);
  useEffect(() => {
    if (editorReady || !file) return;
    let current = true;
    loadEditor().then(
      () => current && setEditorReady(true),
      (error) => current && setToast(`Could not load the editor: ${String(error)}`),
    );
    return () => {
      current = false;
    };
  }, [editorReady, !!file]);
  const stateRef = useRef({ workspaces, activeProject, projects });
  stateRef.current = { workspaces, activeProject, projects };
  const reportedExits = useRef(new Set<string>());
  const terminalInputBuffers = useRef(new Map<string, string>());
  // Agents whose conversation was cleared and wait for a new task to title.
  const agentTitlePending = useRef(new Set<string>());
  const agentActivity = useRef(new Map<string, number>());
  const agentTurns = useRef(new Map<string, AgentTurn>());
  const [dashboardNow, setDashboardNow] = useState(() => Date.now());
  // Plan usage moves while a Claude or Codex reply runs and settles after it finishes.
  const usageAgents = Object.values(workspaces)
    .flatMap((current) => current.terminals)
    .filter((terminal) => terminal.agentId === 'claude' || terminal.agentId === 'codex');
  const usageActive = usageAgents.some(
    (terminal) => terminalStatus(terminal, agentTurns.current.get(terminal.id)) === 'working',
  );
  const usageSignal = usageAgents.reduce(
    (latest, terminal) =>
      Math.max(latest, terminal.finishedAt || 0, agentTurns.current.get(terminal.id)?.completedAt || 0),
    0,
  );
  // The preferred shell is listed first, so new terminals and shell pickers start on it.
  const shells = useMemo(() => {
    const all = boot?.shells || [];
    const preferred = all.find((shell) => shell.id === preferences.defaultShell);
    return preferred ? [preferred, ...all.filter((shell) => shell !== preferred)] : all;
  }, [boot?.shells, preferences.defaultShell]);
  const planUsage = useUsage({
    active: usageActive,
    refreshSignal: usageSignal,
    onAlerts: (alerts) => {
      // Alert state still advances while alerts are off, so turning them back on
      // does not replay warnings already passed.
      if (!preferences.usageAlerts) return;
      for (const alert of alerts) pushNotification({ ...alert, timestamp: Date.now() });
    },
    thresholds: { warning: preferences.usageWarningAt, critical: preferences.usageCriticalAt },
  });
  const error = useCallback(
    (value: unknown) =>
      setToast(
        value instanceof Error
          ? value.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
          : String(value),
      ),
    [],
  );
  const closeNewPaneMenu = useCallback(() => setNewPaneMenu(null), []);
  useEffect(() => {
    if (project && window.workspace) prefetchPaneAgents(project.id, workspaceName);
  }, [project?.id, workspaceName]);
  function requestConfirm(message: string, detail: string, action: string): Promise<boolean> {
    return new Promise((resolve) => setConfirmRequest({ message, detail, action, resolve }));
  }
  function finishConfirm(confirmed: boolean) {
    confirmRequest?.resolve(confirmed);
    setConfirmRequest(null);
  }
  function scheduleAgentCompletion(id: string, turn: AgentTurn) {
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = undefined;
    const remaining = agentTurnSettlesAt(turn) - Date.now();
    const settle = () => {
      if (!settleAgentTurn(turn, Date.now())) return;
      setDashboardNow(Date.now());
      if (preferencesRef.current.doneSound) playDoneSound();
    };
    if (remaining <= 0) {
      settle();
      return;
    }
    turn.timer = setTimeout(() => {
      if (agentTurns.current.get(id) !== turn || turn.completedAt) return;
      turn.timer = undefined;
      settle();
    }, remaining);
  }
  function recordTerminalExit(id: string, code: number, fallback?: TerminalInfo) {
    if (reportedExits.current.has(id)) return;
    const terminal = Object.values(stateRef.current.workspaces)
      .flatMap((current) => current.terminals)
      .find((item) => item.id === id);
    const target = terminal || fallback;
    if (!target) return;
    reportedExits.current.add(id);
    const projectName =
      stateRef.current.projects.find((item) => item.id === target.projectId)?.name || 'Workspace';
    const success = code === 0;
    pushNotification({
      id: `${id}-${Date.now()}`,
      title: success ? 'Task completed' : 'Task failed',
      detail: `${displayTerminalTitle(target.sessionTitle, target.label, target.agentId)} · ${projectName}${success ? '' : ` · exit code ${code}`}`,
      timestamp: Date.now(),
      success,
    });
  }
  const update = useCallback(
    (id: string, fn: (work: Work) => Work) =>
      setWorkspaces((prev) => {
        const next = fn(prev[id] || newWork());
        return next === prev[id] ? prev : { ...prev, [id]: next };
      }),
    [],
  );
  const updateFile = useCallback(
    (id: string, path: string, fn: (file: OpenFile) => OpenFile) =>
      update(id, (w) => {
        let changed = false;
        const files = w.files.map((f) => {
          if (f.path !== path) return f;
          const next = fn(f);
          changed ||= next !== f;
          return next;
        });
        return changed ? { ...w, files } : w;
      }),
    [update],
  );
  useEffect(() => {
    if (!api) return;
    api
      .bootstrap()
      .then((data) => {
        for (const terminal of data.terminals || []) {
          if (!terminal.agentId || terminal.agentId === 'terminal' || !terminal.lastInputAt)
            continue;
          const previous = agentTurns.current.get(terminal.id);
          if (previous?.timer) clearTimeout(previous.timer);
          const turn: AgentTurn = {
            submittedAt: terminal.lastInputAt,
            lastOutputAt: terminal.lastOutputAt || 0,
          };
          agentTurns.current.set(terminal.id, turn);
          scheduleAgentCompletion(terminal.id, turn);
        }
        setBoot(data);
        setProjects(
          data.projects.map((item) => {
            const localPin = localStorage.getItem(`project-pin:${item.id}`);
            return localPin === null ? item : { ...item, pinned: localPin === 'true' };
          }),
        );
        // Live terminals or a launch argument always reopen their project.
        setActiveProject(
          preferences.startup === 'none' && !data.launchProject && !data.terminals?.length
            ? null
            : data.activeProject,
        );
        setWorkspaces(
          Object.fromEntries(
            data.projects.map((p) => [
              p.id,
              {
                ...newWork(),
                ...data.sessions[p.id],
                terminals: (data.terminals || []).filter((terminal) => terminal.projectId === p.id),
              },
            ]),
          ),
        );
      })
      .catch(error);
  }, []);
  useEffect(
    () =>
      api?.onTerminal((event) => {
        if (event.data) {
          const outputAt = event.at || Date.now();
          agentActivity.current.set(event.id, outputAt);
          const turn = agentTurns.current.get(event.id);
          if (turn && outputAt >= turn.submittedAt) {
            const reopened = recordAgentOutput(turn, outputAt);
            scheduleAgentCompletion(event.id, turn);
            if (reopened) setDashboardNow(Date.now());
          }
        }
        if (event.exitCode === undefined) return;
        const turn = agentTurns.current.get(event.id);
        if (turn?.timer) {
          clearTimeout(turn.timer);
          turn.timer = undefined;
        }
        recordTerminalExit(event.id, event.exitCode);
        setWorkspaces((previous) =>
          Object.fromEntries(
            Object.entries(previous).map(([id, w]) => [
              id,
              w.terminals.some((t) => t.id === event.id)
                ? {
                    ...w,
                    terminals: w.terminals.map((t) =>
                      t.id === event.id
                        ? { ...t, exited: true, exitCode: event.exitCode, finishedAt: event.at || Date.now() }
                        : t,
                    ),
                  }
                : w,
            ]),
          ),
        );
      }),
    [],
  );
  useEffect(() => {
    if (mode !== 'code' || !dashboardOpen) return;
    setDashboardNow(Date.now());
    const timer = setInterval(() => setDashboardNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [mode, dashboardOpen]);
  useEffect(() => () => {
    for (const turn of agentTurns.current.values())
      if (turn.timer) clearTimeout(turn.timer);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 7000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const dismissMenus = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.context-menu, .menu-trigger')) return;
      setProjectMenu(null);
      setWorkspaceMenu(null);
    };
    document.addEventListener('mousedown', dismissMenus);
    return () => document.removeEventListener('mousedown', dismissMenus);
  }, []);
  useEffect(() => {
    if (!api || !boot) return;
    const timer = setTimeout(() => {
      for (const [id, current] of Object.entries(workspaces))
        api.saveSession(id, sessionFor(current)).catch(error);
    }, 300);
    return () => clearTimeout(timer);
  }, [workspaces, boot]);
  useEffect(
    () =>
      api?.onBeforeClose(async () => {
        try {
          for (const [id, current] of Object.entries(stateRef.current.workspaces))
            await api.saveSession(id, sessionFor(current));
          await api.windowAction('close-ready');
        } catch (value) {
          error(value);
        }
      }),
    [],
  );
  useEffect(() => {
    if (!revealTarget || file?.path !== revealTarget.path) return;
    const timer = requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.setPosition({ lineNumber: revealTarget.line, column: revealTarget.column });
      editor.revealLineInCenter(revealTarget.line);
      editor.focus();
    });
    return () => cancelAnimationFrame(timer);
  }, [revealTarget, file?.path]);
  useEffect(() => {
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const dialogs = [
        ...document.querySelectorAll<HTMLElement>('[role="dialog"], .modal-backdrop > form'),
      ].filter(element => !element.closest('.monaco-editor') && !isClosing(element) && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length);
      const dialog = dialogs.at(-1);
      if (!dialog) return;
      const items = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ),
      ].filter((element) => element.getClientRects().length);
      const first = items[0],
        last = items.at(-1);
      if (!first || !last) return;
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trap, true);
    return () => document.removeEventListener('keydown', trap, true);
  }, []);
  useEffect(() => {
    if (!api || !activeProject) return;
    let canceled = false;
    const reload = () =>
      api
        .gitStatus(activeProject)
        .then((value) => {
          if (!canceled) setGit(value);
        })
        .catch(error);
    reload();
    const timer = setInterval(reload, 5000);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [activeProject, refresh]);
  useEffect(() => setGit(emptyGit), [activeProject]);
  useEffect(() => {
    if (!api || !activeProject || !file) return;
    let canceled = false;
    const path = file.path;
    const check = async () => {
      try {
        const expectedRevision = stateRef.current.workspaces[activeProject]?.files.find(
          (f) => f.path === path,
        )?.revision;
        const disk = await api.readFile(activeProject, path);
        if (canceled) return;
        updateFile(activeProject, path, (current) => {
          if (current.revision !== expectedRevision) return current;
          if (disk.revision === current.revision) return current;
          if (current.conflict?.revision === disk.revision) return current;
          return current.content === current.saved
            ? { ...current, ...disk, saved: disk.content, conflict: undefined }
            : { ...current, conflict: disk };
        });
      } catch {
        /* Saving still surfaces deleted or inaccessible files as an error. */
      }
    };
    check();
    const timer = setInterval(check, 2500);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [activeProject, file?.path]);
  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      const dirty = Object.values(stateRef.current.workspaces).some((w) =>
        w.files.some((f) => f.content !== f.saved),
      );
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', listener);
    return () => window.removeEventListener('beforeunload', listener);
  }, []);
  async function persistCurrent() {
    if (api && activeProject && work) await api.saveSession(activeProject, sessionFor(work));
  }
  async function openProject() {
    if (!api) return;
    try {
      await persistCurrent();
      const next = await api.pickProject();
      if (!next) return;
      setProjects((prev) => (prev.some((p) => p.id === next.id) ? prev : [...prev, next]));
      update(next.id, (w) => w);
      setActiveTerminalId(null);
      setFullScreenTerminalId(null);
      setActiveProject(next.id);
      resetBrowser();
    } catch (value) {
      error(value);
    }
  }
  async function switchProject(id: string) {
    try {
      await persistCurrent();
      await api!.activateProject(id);
      setActiveTerminalId(null);
      setFullScreenTerminalId(null);
      setActiveProject(id);
      resetBrowser();
    } catch (value) {
      error(value);
    }
  }
  async function openDashboardAgent(terminal: TerminalInfo) {
    if (!api) return;
    try {
      if (terminal.projectId !== activeProject) {
        await persistCurrent();
        await api.activateProject(terminal.projectId);
        setActiveProject(terminal.projectId);
        resetBrowser();
      }
      setFullScreenTerminalId(null);
      update(terminal.projectId, (current) => ({
        ...current,
        activeWorkspace: terminal.workspaceName || 'Main',
        layout: 'terminal',
      }));
      setMode('code');
      activateTerminal(terminal.id);
      window.clearTimeout(beaconTimer.current);
      setBeacon({ id: terminal.id, nonce: Date.now() });
      beaconTimer.current = window.setTimeout(() => setBeacon(null), 1600);
    } catch (value) {
      error(value);
    }
  }
  async function openFile(path: string, line = 1, column = 1) {
    setRevealTarget({ path, line, column });
    if (!api || !activeProject) return;
    const id = activeProject;
    try {
      if (work?.files.some((f) => f.path === path)) {
        update(id, (w) => ({
          ...w,
          activeFile: path,
          layout: w.layout === 'terminal' ? 'focus' : w.layout,
        }));
        return;
      }
      const disk = await api.readFile(id, path);
      update(id, (w) => ({
        ...w,
        activeFile: path,
        layout: w.layout === 'terminal' ? 'focus' : w.layout,
        files: w.files.some((f) => f.path === path)
          ? w.files
          : [...w.files, { ...disk, path, saved: disk.content }],
      }));
    } catch (value) {
      error(value);
    }
  }
  function askAboutFile() {
    if (!file || !project) return;
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const selected =
      selection && !selection.isEmpty()
        ? editor?.getModel()?.getValueInRange(selection).trim()
        : '';
    const snippet = selected?.slice(0, 8000);
    const attachActiveFile = !snippet && file.content.length <= 100000;
    const draft = snippet
      ? `Help me with this selection from ${file.path}:\n\n\`\`\`${language(file.path)}\n${snippet}\n\`\`\``
      : attachActiveFile
        ? `Help me with ${file.path}.`
        : `Help me with ${file.path}. This file is too large to attach; paste the relevant section here.`;
    setChatHandoff({ id: crypto.randomUUID(), projectId: project.id, draft, attachActiveFile });
    openChat();
  }
  async function saveFile(
    keepMine = false,
    targetProject = activeProject,
    targetPath = file?.path,
  ): Promise<boolean> {
    const target = targetProject && stateRef.current.workspaces[targetProject]?.files.find(
      (item) => item.path === targetPath,
    );
    if (!api || !targetProject || !target || savingFile.current) return false;
    const id = targetProject;
    savingFile.current = true;
    setBusy(true);
    try {
      const result = await api.saveFile(
        id,
        target.path,
        target.content,
        keepMine && target.conflict ? target.conflict.revision : target.revision,
      );
      updateFile(id, target.path, (current) =>
        result.conflict
          ? { ...current, conflict: { content: result.content!, revision: result.revision } }
          : { ...current, saved: target.content, revision: result.revision, conflict: undefined },
      );
      if (!result.conflict) {
        setToast(`Saved ${baseName(target.path)}`);
        setRefresh((n) => n + 1);
      }
      return !result.conflict;
    } catch (value) {
      error(value);
      return false;
    } finally {
      savingFile.current = false;
      setBusy(false);
    }
  }
  async function saveAllFiles() {
    if (!activeProject || savingFile.current) return;
    const id = activeProject;
    const targets = stateRef.current.workspaces[id]?.files.filter(
      (item) => item.content !== item.saved,
    ) || [];
    let saved = 0;
    for (const target of targets) {
      if (!(await saveFile(false, id, target.path))) return;
      saved++;
    }
    if (saved) setToast(`Saved ${saved} ${saved === 1 ? 'file' : 'files'}`);
  }
  function removeFile(id: string, path: string, onlySaved = false) {
    update(id, (w) => {
      if (onlySaved && w.files.some((item) => item.path === path && item.content !== item.saved))
        return w;
      const index = w.files.findIndex((item) => item.path === path);
      const files = w.files.filter((item) => item.path !== path);
      return {
        ...w,
        files,
        activeFile: w.activeFile === path ? files[Math.min(index, files.length - 1)]?.path : w.activeFile,
      };
    });
  }
  async function closeFile(target: OpenFile) {
    if (!api || !activeProject || savingFile.current) return;
    if (target.content !== target.saved) {
      setClosingFile({ projectId: activeProject, path: target.path });
      return;
    }
    removeFile(activeProject, target.path);
  }
  // A plugin command runs in a new terminal pane, where its output stays visible.
  async function startPluginCommand(key: string) {
    if (!api || !project) throw new Error('Open a project first.');
    showPluginTerminal(await api.pluginsRunCommand(project.id, key, workspaceName));
  }
  function showPluginTerminal(next: TerminalInfo) {
    update(next.projectId, (current) => ({
      ...current,
      layout: current.layout === 'focus' ? 'terminal' : current.layout,
      terminals: [...current.terminals, { ...next, workspaceName: next.workspaceName || 'Main' }],
    }));
    setMode('code');
    setActiveTerminalId(next.id);
  }
  function runPluginCommand(key: string) {
    startPluginCommand(key).catch((error) => setToast(`Could not run the plugin command: ${pluginError(error)}`));
  }
  // Types a plugin prompt into an agent without submitting it.
  async function typePluginPrompt(text: string) {
    if (!api || !promptTarget) throw new Error('Start an agent terminal first.');
    setMode('code');
    setActiveTerminalId(promptTarget.id);
    await api.writeTerminal(promptTarget.id, terminalPaste(text));
  }
  // Sends a change request picked in the browser to the agent the user is
  // working with: the focused one, else the newest running agent here.
  async function sendBrowserPrompt(prompt: string) {
    const agents = visibleTerminals.filter(
      (t) => !!t.agentId && t.agentId !== 'terminal' && !t.exited,
    );
    const target = agents.find((t) => t.id === activeTerminalId) ?? agents.at(-1);
    if (!api || !target) throw new Error('Open an agent first, then send your change request.');
    // A bracketed paste keeps the line breaks in one prompt; the agent
    // submits it on the Enter that follows. The prompt quotes the page, so
    // control characters that could end the paste early are dropped.
    const paste = terminalPaste(prompt);
    recordTerminalInput(target, `${paste}\r`);
    setActiveTerminalId(target.id);
    await api.writeTerminal(target.id, paste);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await api.writeTerminal(target.id, '\r');
  }
  function recordTerminalInput(info: TerminalInfo, data: string) {
    let buffer = terminalInputBuffers.current.get(info.id) || '';
    const submitted: string[] = [];
    // Line breaks inside a bracketed paste belong to one prompt, not several.
    const typed = stripTerminalControls(
      data.replace(/\u001b\[200~([\s\S]*?)\u001b\[201~/g, (_, text: string) =>
        text.replace(/[\r\n]+/g, ' '),
      ),
    );
    const turn = agentTurns.current.get(info.id);
    if (turn && typed) recordAgentKeystroke(turn, Date.now());
    for (const character of typed) {
      // Ctrl+C and Ctrl+U clear the line; Ctrl+W deletes the last word.
      if (character === '\u0003' || character === '\u0015') {
        buffer = '';
        continue;
      }
      if (character === '\u0017') {
        buffer = buffer.replace(/\S*\s*$/, '');
        continue;
      }
      if (character === '\r' || character === '\n') {
        const command = buffer.replace(/\s+/g, ' ').trim();
        if (command) submitted.push(command);
        buffer = '';
        continue;
      }
      if (character === '\u0008' || character === '\u007f') {
        buffer = buffer.slice(0, -1);
        continue;
      }
      if (character === '\t') {
        buffer += ' ';
        continue;
      }
      if (character >= ' ') buffer = `${buffer}${character}`.slice(-2000);
    }
    terminalInputBuffers.current.set(info.id, buffer);
    if (!submitted.length) return;
    const agentSubmittedAt = info.agentId && info.agentId !== 'terminal'
      ? Math.max(Date.now(), (info.lastInputAt || 0) + 1)
      : 0;
    if (agentSubmittedAt) {
      if (turn?.timer) clearTimeout(turn.timer);
      const next: AgentTurn = { submittedAt: agentSubmittedAt, lastOutputAt: 0 };
      agentTurns.current.set(info.id, next);
      // Settles even if the agent never prints, rather than staying Working.
      scheduleAgentCompletion(info.id, next);
    }
    let title: string | undefined;
    if (agentSubmittedAt) {
      // An agent keeps the title of the task it was first given; follow-ups
      // refine that task. Clearing its conversation starts a new one.
      let needsTitle =
        agentTitlePending.current.has(info.id) ||
        displayTerminalTitle(info.sessionTitle, info.label, info.agentId) ===
          displayTerminalLabel(info.label, info.agentId);
      for (const prompt of submitted) {
        if (isAgentContextReset(prompt)) needsTitle = true;
        else if (needsTitle) {
          const next = summarizeAgentPrompt(prompt);
          if (next) {
            title = next;
            needsTitle = false;
          }
        }
      }
      if (needsTitle) agentTitlePending.current.add(info.id);
      else agentTitlePending.current.delete(info.id);
    } else {
      title = summarizeShellCommands(submitted);
      if (!title) return;
    }
    update(info.projectId, (w) => {
      let changed = false;
      const terminals = w.terminals.map((terminal) => {
        if (terminal.id !== info.id) return terminal;
        if (!agentSubmittedAt && terminal.sessionTitle === title) return terminal;
        changed = true;
        return {
          ...terminal,
          ...(agentSubmittedAt ? { lastInputAt: agentSubmittedAt } : {}),
          ...(title ? { sessionTitle: title } : {}),
        };
      });
      return changed ? { ...w, terminals } : w;
    });
  }
  function forgetTerminalInput(id: string) {
    terminalInputBuffers.current.delete(id);
    agentTitlePending.current.delete(id);
    agentActivity.current.delete(id);
    const turn = agentTurns.current.get(id);
    if (turn?.timer) clearTimeout(turn.timer);
    agentTurns.current.delete(id);
  }
  async function addTerminal(
    shell?: string,
    label?: string,
    agentId?: string,
    targetWorkspace = workspaceName,
    sessionTitle?: string,
  ) {
    if (!api || !activeProject) return;
    const id = activeProject;
    try {
      let next: TerminalInfo;
      if (agentId) {
        const result = await api.launchAgents(id, [{ agentId, count: 1 }], shell ?? shells[0]?.id, targetWorkspace);
        if (!result.created.length)
          throw new Error(result.errors.join(' ') || 'Agent could not start.');
        next = result.created[0];
      } else next = await api.createTerminal(id, shell ?? shells[0]?.id, targetWorkspace);
      update(id, (w) => ({
        ...w,
        layout: w.layout === 'focus' ? 'terminal' : w.layout,
        terminals: [
          ...w.terminals,
          {
            ...next,
            workspaceName: targetWorkspace,
            label: label || `${next.label} ${w.terminals.length + 1}`,
            sessionTitle: sessionTitle ?? next.sessionTitle,
          },
        ],
      }));
      setMode('code');
      setActiveTerminalId(next.id);
    } catch (value) {
      error(value);
    }
  }
  async function addAgentTerminals(selections: AgentSelection[], targetWorkspace = workspaceName) {
    if (!api || !activeProject || !selections.length) return;
    const id = activeProject;
    try {
      const result = await api.launchAgents(id, selections, shells[0]?.id, targetWorkspace);
      if (!result.created.length)
        throw new Error(result.errors.join(' ') || 'Agent could not start.');
      update(id, (w) => ({
        ...w,
        layout: w.layout === 'focus' ? 'terminal' : w.layout,
        terminals: [
          ...w.terminals,
          ...result.created.map((terminal) => ({ ...terminal, workspaceName: targetWorkspace })),
        ],
      }));
      if (result.errors.length) error(result.errors.join(' '));
    } catch (value) {
      error(value);
      throw value;
    }
  }
  async function closeTerminal(info: TerminalInfo) {
    if (!api) return;
    const displayTitle = displayTerminalTitle(info.sessionTitle, info.label, info.agentId);
    if (
      !info.exited &&
      !(await requestConfirm(
        `Close ${displayTitle}?`,
        'The shell and its running processes will be stopped.',
        'Close',
      ))
    )
      return;
    try {
      await api.closeTerminal(info.id);
      forgetTerminalInput(info.id);
      if (activeTerminalId === info.id) setActiveTerminalId(null);
      if (fullScreenTerminalId === info.id) setFullScreenTerminalId(null);
      update(info.projectId, (w) => ({
        ...w,
        terminals: w.terminals.filter((t) => t.id !== info.id),
        terminalPresets: w.terminalPresets?.filter(
          (preset) => (preset.workspaceName || 'Main') !== (info.workspaceName || 'Main'),
        ),
      }));
    } catch (value) {
      error(value);
    }
  }
  async function closeAllTerminals() {
    if (!api || !activeProject || !visibleTerminals.length) return;
    const runningCount = visibleTerminals.filter((terminal) => !terminal.exited).length;
    const detail = runningCount
      ? `${runningCount} running ${runningCount === 1 ? 'process' : 'processes'} will be stopped.`
      : 'The terminal tabs will be removed from this workspace.';
    if (!(await requestConfirm(`Close all terminals in “${workspaceName}”?`, detail, 'Close all')))
      return;

    const results = await Promise.allSettled(
      visibleTerminals.map((terminal) => api.closeTerminal(terminal.id)),
    );
    const closedIds = new Set(
      visibleTerminals.filter((_, index) => results[index].status === 'fulfilled').map((t) => t.id),
    );
    closedIds.forEach((id) => forgetTerminalInput(id));
    if (activeTerminalId && closedIds.has(activeTerminalId)) setActiveTerminalId(null);
    if (fullScreenTerminalId && closedIds.has(fullScreenTerminalId)) setFullScreenTerminalId(null);
    update(activeProject, (w) => ({
      ...w,
      terminals: w.terminals.filter((terminal) => !closedIds.has(terminal.id)),
      terminalPresets: w.terminalPresets?.filter(
        (preset) => (preset.workspaceName || 'Main') !== workspaceName,
      ),
    }));
    if (closedIds.size !== visibleTerminals.length)
      setToast(
        `${closedIds.size} of ${visibleTerminals.length} terminals closed. Some terminals could not be stopped.`,
      );
  }
  async function deleteWorkspace(projectId: string, name: string) {
    if (!api) return;
    const target = workspaces[projectId] || newWork();
    const names = target.workspaceNames || ['Main'];
    if (names.length === 1 && names[0] === 'Main') {
      setToast('Main workspace is required. Create another workspace before deleting one.');
      return;
    }
    if (
      !(await requestConfirm(
        `Delete workspace “${name}”?`,
        'Its open terminals will be closed and its saved layout will be removed.',
        'Delete workspace',
      ))
    )
      return;
    const terminals = target.terminals.filter((t) => (t.workspaceName || 'Main') === name);
    const results = await Promise.allSettled(terminals.map((t) => api.closeTerminal(t.id)));
    const failed = results.some((result) => result.status === 'rejected');
    const closedIds = new Set(
      terminals.filter((_, index) => results[index].status === 'fulfilled').map((item) => item.id),
    );
    closedIds.forEach(forgetTerminalInput);
    if (failed) {
      update(projectId, (current) => ({
        ...current,
        terminals: current.terminals.filter((item) => !closedIds.has(item.id)),
      }));
      setToast('Some terminals could not be stopped. The workspace has been kept; try again.');
      return;
    }
    const remaining = names.filter((workspace) => workspace !== name);
    const nextNames = remaining.length ? remaining : ['Main'];
    update(projectId, (current) => ({
      ...current,
      workspaceNames: nextNames,
      activeWorkspace:
        current.activeWorkspace === name ? nextNames[0] : current.activeWorkspace || nextNames[0],
      terminals: current.terminals.filter((t) => (t.workspaceName || 'Main') !== name),
      terminalPresets: current.terminalPresets?.filter((t) => (t.workspaceName || 'Main') !== name),
      workspaceMeta: withoutKey(current.workspaceMeta, name),
      layout: 'terminal',
    }));
    setActiveTerminalId(null);
    setFullScreenTerminalId(null);
    setCollapsedWorkspaces((previous) => {
      const next = { ...previous };
      delete next[`${projectId}:${name}`];
      return next;
    });
    setToast(
      failed ? `Deleted ${name}; one or more terminals could not be stopped.` : `Deleted ${name}`,
    );
  }
  async function deleteProject(target: Project) {
    if (!api) return;
    const session = workspaces[target.id] || newWork();
    const dirty = session.files.some((f) => f.content !== f.saved);
    const terminalCount = session.terminals.filter((t) => !t.exited).length;
    const detail = [
      'This removes the project from the side panel; files on disk are kept.',
      terminalCount
        ? `${terminalCount} running terminal${terminalCount === 1 ? '' : 's'} will be closed.`
        : '',
      dirty ? 'Unsaved editor changes in this project will be discarded.' : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (!(await requestConfirm(`Remove project “${target.name}”?`, detail, 'Remove project')))
      return;
    try {
      const nextActive = await api.removeProject(target.id);
      setProjects((previous) => previous.filter((item) => item.id !== target.id));
      setWorkspaces((previous) => {
        const next = { ...previous };
        delete next[target.id];
        return next;
      });
      setCollapsedProjects((previous) => {
        const next = { ...previous };
        delete next[target.id];
        return next;
      });
      setActiveProject(nextActive);
      setActiveTerminalId(null);
      setFullScreenTerminalId(null);
      resetBrowser();
      setToast(`Removed ${target.name}; its files remain on disk.`);
    } catch (value) {
      error(value);
    }
  }
  async function toggleProjectPin(target: Project) {
    if (!api) return;
    const pinned = !target.pinned;
    // Keep pinning usable while a Vite hot reload is paired with an older preload.
    if (typeof api.updateProject !== 'function') {
      localStorage.setItem(`project-pin:${target.id}`, String(pinned));
      setProjects((previous) =>
        previous.map((item) => (item.id === target.id ? { ...item, pinned } : item)),
      );
      setProjectMenu(null);
      setToast(pinned ? `Pinned ${target.name}` : `Unpinned ${target.name}`);
      return;
    }
    try {
      const updated = await api.updateProject(target.id, { pinned });
      localStorage.setItem(`project-pin:${target.id}`, String(Boolean(updated.pinned)));
      setProjects((previous) =>
        previous.map((item) => (item.id === target.id ? { ...item, ...updated } : item)),
      );
      setProjectMenu(null);
      setToast(updated.pinned ? `Pinned ${target.name}` : `Unpinned ${target.name}`);
    } catch (value) {
      error(value);
    }
  }
  useEffect(() => setWorkspaceMenuView('main'), [workspaceMenu]);
  function setWorkspaceMeta(projectId: string, name: string, patch: WorkspaceMeta) {
    update(projectId, (current) => {
      const next: WorkspaceMeta = { ...current.workspaceMeta?.[name], ...patch };
      for (const key of Object.keys(next) as (keyof WorkspaceMeta)[])
        if (next[key] === undefined || next[key] === false) delete next[key];
      const meta = withoutKey(current.workspaceMeta, name);
      if (Object.keys(next).length) meta[name] = next;
      return { ...current, workspaceMeta: meta };
    });
  }
  function toggleWorkspaceFlag(projectId: string, name: string, flag: 'pinned' | 'unread') {
    const on = !workspaces[projectId]?.workspaceMeta?.[name]?.[flag];
    setWorkspaceMenu(null);
    setWorkspaceMeta(projectId, name, { [flag]: on });
    if (flag === 'pinned') setToast(on ? `Pinned ${name}` : `Unpinned ${name}`);
  }
  function archiveWorkspace(projectId: string, name: string) {
    const target = workspaces[projectId] || newWork();
    const archived = !target.workspaceMeta?.[name]?.archived;
    setWorkspaceMenu(null);
    if (!archived) {
      setWorkspaceMeta(projectId, name, { archived: false });
      setToast(`Restored ${name}`);
      return;
    }
    const visible = (target.workspaceNames || ['Main']).filter(
      (item) => item !== name && !target.workspaceMeta?.[item]?.archived,
    );
    if (!visible.length) {
      setToast('Keep at least one workspace visible. Create another before archiving this one.');
      return;
    }
    setWorkspaceMeta(projectId, name, { archived: true, unread: false });
    if ((target.activeWorkspace || 'Main') === name) {
      setActiveTerminalId(null);
      setFullScreenTerminalId(null);
      update(projectId, (current) => ({ ...current, activeWorkspace: visible[0], layout: 'terminal' }));
    }
    setToast(`Archived ${name}. Its terminals keep running; find it under Archived.`);
  }
  function moveWorkspaceToGroup(projectId: string, name: string, group: string | undefined) {
    setWorkspaceMenu(null);
    setGroupPrompt(null);
    setWorkspaceMeta(projectId, name, { group });
    setToast(group ? `Moved ${name} to ${group}` : `Removed ${name} from its group`);
  }
  function saveGroupPrompt() {
    if (!groupPrompt) return;
    const group = groupPrompt.value.trim();
    if (!group) {
      setToast('Group names cannot be empty.');
      return;
    }
    moveWorkspaceToGroup(groupPrompt.projectId, groupPrompt.name, group);
  }
  function openWorkspaceRename(projectId: string, name: string) {
    setWorkspaceMenu(null);
    setWorkspaceRename({ projectId, name, value: name });
  }
  async function createWorkspace(projectId: string) {
    if (activeProject !== projectId) {
      try {
        await switchProject(projectId);
      } catch (value) {
        error(value);
        return;
      }
    }
    setProjectMenu(null);
    setWorkspaceMenu(null);
    setActiveTerminalId(null);
    setFullScreenTerminalId(null);
    update(projectId, (current) => {
      const names = current.workspaceNames || ['Main'];
      let index = names.length + 1;
      let name = `Workspace ${index}`;
      while (names.includes(name)) {
        index += 1;
        name = `Workspace ${index}`;
      }
      return {
        ...current,
        workspaceNames: [...names, name],
        activeWorkspace: name,
        layout: 'terminal',
      };
    });
    setToast('Created a new workspace');
  }
  async function saveWorkspaceRename() {
    if (!workspaceRename) return;
    const { projectId, name, value } = workspaceRename;
    const nextName = value.trim();
    if (!nextName) {
      setToast('Workspace names cannot be empty.');
      return;
    }
    const target = workspaces[projectId] || newWork();
    const names = target.workspaceNames || ['Main'];
    if (names.some((item) => item !== name && item.toLowerCase() === nextName.toLowerCase())) {
      setToast('A workspace with that name already exists.');
      return;
    }
    try {
      await api!.renameWorkspace(projectId, name, nextName);
    } catch (value) {
      error(value);
      return;
    }
    update(projectId, (current) => ({
      ...current,
      workspaceNames: (current.workspaceNames || ['Main']).map((item) =>
        item === name ? nextName : item,
      ),
      workspaceMeta: current.workspaceMeta?.[name]
        ? { ...withoutKey(current.workspaceMeta, name), [nextName]: current.workspaceMeta[name] }
        : current.workspaceMeta,
      activeWorkspace:
        current.activeWorkspace === name ? nextName : current.activeWorkspace || nextName,
      terminals: current.terminals.map((terminal) =>
        (terminal.workspaceName || 'Main') === name
          ? { ...terminal, workspaceName: nextName }
          : terminal,
      ),
      terminalPresets: current.terminalPresets?.map((preset) =>
        (preset.workspaceName || 'Main') === name ? { ...preset, workspaceName: nextName } : preset,
      ),
    }));
    setCollapsedWorkspaces((previous) => {
      const next = { ...previous };
      const oldKey = `${projectId}:${name}`;
      const newKey = `${projectId}:${nextName}`;
      if (oldKey in next) next[newKey] = next[oldKey];
      delete next[oldKey];
      return next;
    });
    setWorkspaceRename(null);
    setToast(`Renamed workspace to ${nextName}`);
  }
  const setLayout = (layout: Layout) => {
    setFullScreenTerminalId(null);
    if (activeProject) update(activeProject, (w) => ({ ...w, layout }));
  };
  function openBrowser() {
    setBrowserFullscreen(false);
    setBrowserMounted(true);
    setBrowserOpen(true);
  }
  // Fullscreen is left as is, so a fullscreen browser closes without sliding;
  // openBrowser resets it.
  function closeBrowser() {
    setBrowserOpen(false);
  }
  // Another project's pages do not belong here, so switching projects closes
  // the browser and discards its tabs.
  function resetBrowser() {
    closeBrowser();
    setBrowserMounted(false);
    setBrowserSession((session) => session + 1);
  }
  function toggleBrowser() {
    if (browserOpen) closeBrowser();
    else openBrowser();
  }
  function toggleNewPaneMenu(event: React.MouseEvent<HTMLButtonElement>, trigger: string) {
    event.stopPropagation();
    const anchor = event.currentTarget;
    setNewPaneMenu((current) => (current?.trigger === trigger ? null : { anchor, trigger }));
  }
  function activateTerminal(id: string) {
    setActiveTerminalId(id);
    requestAnimationFrame(() => {
      const pane = document.getElementById(`terminal-${id}`);
      pane?.scrollIntoView({ block: 'nearest' });
      pane?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus();
    });
  }
  function moveTerminal(sourceId: string, targetId: string, edge: 'before' | 'after') {
    if (!activeProject || sourceId === targetId) return;
    update(activeProject, (current) => {
      const source = current.terminals.find((terminal) => terminal.id === sourceId);
      const target = current.terminals.find((terminal) => terminal.id === targetId);
      if (
        !source ||
        !target ||
        (source.workspaceName || 'Main') !== (target.workspaceName || 'Main')
      )
        return current;
      const terminals = current.terminals.filter((terminal) => terminal.id !== sourceId);
      const targetIndex = terminals.findIndex((terminal) => terminal.id === targetId);
      terminals.splice(targetIndex + (edge === 'after' ? 1 : 0), 0, source);
      return { ...current, terminals };
    });
    setActiveTerminalId(sourceId);
  }
  function moveTerminalBy(
    sourceId: string,
    key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown',
  ) {
    let direction: number;
    if (terminalColumnCount === 1) {
      direction = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
    } else {
      direction = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -terminalColumnCount,
        ArrowDown: terminalColumnCount,
      }[key];
    }
    const index = visibleTerminals.findIndex((terminal) => terminal.id === sourceId);
    const target = visibleTerminals[index + direction];
    if (!target) return;
    moveTerminal(sourceId, target.id, direction < 0 ? 'before' : 'after');
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`#terminal-${CSS.escape(sourceId)} .terminal-pane-header`)
        ?.focus(),
    );
  }
  function commitTerminalOrder(ids: string[]) {
    if (!activeProject) return;
    update(activeProject, (current) => {
      const wanted = new Set(ids);
      const slots: number[] = [];
      current.terminals.forEach((terminal, index) => {
        if (wanted.has(terminal.id)) slots.push(index);
      });
      if (slots.length !== ids.length) return current;
      const byId = new Map(current.terminals.map((terminal) => [terminal.id, terminal]));
      const terminals = [...current.terminals];
      slots.forEach((slot, index) => {
        terminals[slot] = byId.get(ids[index])!;
      });
      return { ...current, terminals };
    });
  }
  function toggleTerminalFullscreen(id: string) {
    if (!activeProject) return;
    setActiveTerminalId(id);
    if (fullScreenTerminalId === id) {
      setFullScreenTerminalId(null);
      update(activeProject, (w) => ({ ...w, layout: 'terminal' }));
      return;
    }
    setExplorer(false);
    setFullScreenTerminalId(id);
    update(activeProject, (w) => ({ ...w, layout: 'terminal' }));
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (agentLauncher) return;
      if (event.key === 'Escape') {
        if (confirmRequest) {
          finishConfirm(false);
          return;
        }
        if (workspaceRename) {
          setWorkspaceRename(null);
          return;
        }
        if (groupPrompt) {
          setGroupPrompt(null);
          return;
        }
        if (projectMenu || workspaceMenu) {
          setProjectMenu(null);
          setWorkspaceMenu(null);
          return;
        }
        setPalette(false);
        setQuickOpen(false);
        setSettings(false);
        setDiff(null);
        setNotificationsOpen(false);
      }
      if (Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], .modal-backdrop')).some(element =>
        !element.closest('.monaco-editor') && !isClosing(element) && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length)) return;
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (event.shiftKey) void saveAllFiles();
        else void saveFile();
      }
      if (event.key.toLowerCase() === 'b') {
        if (event.target instanceof Element && event.target.closest('.terminal-pane')) return;
        event.preventDefault();
        // Ctrl Shift B toggles the sidebar of whichever mode is showing.
        if (event.shiftKey && mode === 'chat') setChatSidebar((value) => !value);
        else if (event.shiftKey) setProjectsPanel((value) => !value);
        else {
          setMode('code');
          setExplorer((value) => !value);
        }
      }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((p) => !p);
      }
      if (event.key.toLowerCase() === 'p') {
        event.preventDefault();
        if (activeProject) setQuickOpen((value) => !value);
      }
      if (event.key === '`') {
        event.preventDefault();
        addTerminal();
      }
      if (event.key.toLowerCase() === 'o') {
        event.preventDefault();
        openProject();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const allCommands: PaletteCommand[] = [
    {
      label: 'Agent dashboard',
      hint: '',
      action: () => { setMode('code'); setDashboardOpen(true); },
      icon: LayoutDashboard,
    },
    { label: 'Open project folder', hint: 'Ctrl O', action: openProject, icon: FolderOpen },
    { label: 'Quick open file', hint: 'Ctrl P', action: () => setQuickOpen(true), icon: Files },
    { label: 'Run command', hint: '', action: () => setRunCommands(true), icon: SquareTerminal },
    { label: 'New terminal', hint: 'Ctrl `', action: () => addTerminal(), icon: SquareTerminal },
    {
      label: 'Launch multiple agents',
      hint: '',
      action: () => {
        if (project) setAgentLauncher(true);
      },
      icon: Zap,
    },
    { label: 'Save current file', hint: 'Ctrl S', action: () => saveFile(), icon: ArrowDownToLine },
    { label: 'Save all files', hint: 'Ctrl Shift S', action: () => saveAllFiles(), icon: ArrowDownToLine },
    { label: 'Toggle file explorer', hint: 'Ctrl B', action: () => { setMode('code'); setExplorer((value) => !value); }, icon: Files },
    { label: 'Toggle projects sidebar', hint: 'Ctrl Shift B', action: () => { setMode('code'); setProjectsPanel((value) => !value); }, icon: PanelLeft },
    {
      label: 'Find files in project',
      hint: '',
      action: () => {
        setMode('code');
        setExplorer(true);
        setSection('search');
      },
      icon: Search,
    },
    { label: 'Focus editor', hint: '', action: () => setLayout('focus'), icon: Code2 },
    { label: 'Terminal layout', hint: '', action: () => setLayout('terminal'), icon: PanelBottom },
    { label: 'Workspace settings', hint: '', action: () => setSettings(true), icon: Settings2 },
    { label: 'Plugins', hint: '', action: () => setPluginsOpen(true), icon: Zap },
  ].filter(
    (c) =>
      project || ['Agent dashboard', 'Open project folder', 'Workspace settings', 'Plugins'].includes(c.label),
  );
  if (project) {
    for (const command of pluginContributions.commands)
      allCommands.push({
        id: `plugin-command:${command.key}`,
        label: command.title,
        hint: '',
        source: command.plugin,
        action: () => runPluginCommand(command.key),
        icon: Play,
      });
    for (const prompt of pluginContributions.prompts)
      allCommands.push({
        id: `plugin-prompt:${prompt.key}`,
        label: `${prompt.kind === 'skill' ? 'Skill' : 'Prompt'}: ${prompt.title}`,
        hint: '',
        source: prompt.plugin,
        action: () => setPluginPrompt(prompt),
        icon: FileText,
      });
  }
  function resizeTerminals(event: React.PointerEvent<HTMLDivElement>) {
    const id = activeProject;
    if (!id || !work) return;
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    document.body.classList.add('row-resizing');
    const start = event.clientY,
      height = work.terminalHeight;
    let clientY = start;
    let frame = 0;
    // Commit at most once per frame; pointer events arrive faster than paints.
    const apply = () => {
      frame = 0;
      const terminalHeight = Math.max(
        160,
        Math.min(window.innerHeight - 300, height + start - clientY),
      );
      update(id, (w) => (w.terminalHeight === terminalHeight ? w : { ...w, terminalHeight }));
    };
    const move = (e: PointerEvent) => {
      clientY = e.clientY;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const end = () => {
      if (frame) cancelAnimationFrame(frame);
      apply();
      document.body.classList.remove('row-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }
  const projectSections = [
    { id: 'pinned', title: 'Pinned', projects: orderedProjects.filter((item) => item.pinned) },
    { id: 'projects', title: 'Projects', projects: orderedProjects.filter((item) => !item.pinned) },
  ].filter((section) => section.projects.length);
  if (!api)
    return (
      <div className="browser-notice">
        <img className="brand-logo" src={veyoIcon} alt="" />
        <h1>Veyo</h1>
        <p>This workspace runs as a desktop app to access your files and terminals.</p>
        <code>npm run dev</code>
      </div>
    );
  function renderWorkspace(p: Project, name: string) {
    const meta = work?.workspaceMeta?.[name] || {};
    const groups = workspaceGroups(work?.workspaceMeta);
    return (
      <div key={name}>
        <div
          className={`workspace-row-wrap${dragWorkspace?.name === name && dragWorkspace.projectId === p.id ? ' dragging' : ''}`}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', name);
            setDragWorkspace({ projectId: p.id, name });
          }}
          onDragEnd={() => {
            setDragWorkspace(null);
            setDropSection(null);
          }}
        >
          <button
            className={`workspace-row ${meta.unread ? 'unread' : ''} ${meta.archived ? 'archived' : ''} ${workspaceName === name && !activeTerminalId ? 'active' : ''}`}
            onClick={() => {
              if (workspaceName !== name) {
                setActiveTerminalId(null);
                setFullScreenTerminalId(null);
              }
              update(p.id, (w) => ({
                ...w,
                activeWorkspace: name,
                layout: 'terminal',
              }));
              if (meta.unread) setWorkspaceMeta(p.id, name, { unread: false });
            }}
          >
            <span>{name}</span>
            {meta.unread && (
              <i className="workspace-unread" aria-label="Unread" role="img" />
            )}
            <small>
              {work?.terminals.filter(
                (t) => (t.workspaceName || 'Main') === name,
              ).length || 'No sessions'}
            </small>
          </button>
          <button
            className={`disclosure-button ${collapsedWorkspaces[`${p.id}:${name}`] ? 'collapsed' : ''}`}
            aria-label={`${collapsedWorkspaces[`${p.id}:${name}`] ? 'Expand' : 'Collapse'} ${name}`}
            aria-expanded={!collapsedWorkspaces[`${p.id}:${name}`]}
            onClick={() =>
              setCollapsedWorkspaces((previous) => ({
                ...previous,
                [`${p.id}:${name}`]: !previous[`${p.id}:${name}`],
              }))
            }
          >
            <ChevronDown size={13} />
          </button>
          <button
            className="menu-trigger"
            aria-label={`More options for ${name}`}
            aria-haspopup="menu"
            aria-expanded={workspaceMenu === `${p.id}:${name}`}
            title="Workspace options"
            onClick={(event) => {
              setProjectMenu(null);
              setMenuAnchor(event.currentTarget);
              setWorkspaceMenu((current) =>
                current === `${p.id}:${name}` ? null : `${p.id}:${name}`,
              );
            }}
          >
            <MoreHorizontal size={14} />
          </button>
          <AnimatePresence>
            {workspaceMenu === `${p.id}:${name}` && (
              <AnchoredPopover
                anchor={menuAnchor}
                className="context-menu workspace-context-menu"
                role="menu"
              >
                  <>
                    <button
                      role="menuitem"
                      onClick={() => toggleWorkspaceFlag(p.id, name, 'pinned')}
                    >
                      {meta.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                      <span>{meta.pinned ? 'Unpin' : 'Pin'}</span>
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => toggleWorkspaceFlag(p.id, name, 'unread')}
                    >
                      <CircleDot size={14} />
                      <span>{meta.unread ? 'Mark as read' : 'Mark as unread'}</span>
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => openWorkspaceRename(p.id, name)}
                    >
                      <Pencil size={14} />
                      <span>Rename</span>
                    </button>
                    <div className="menu-separator" role="separator" />
                    <div
                      className="menu-submenu-wrap"
                      onMouseEnter={() => setWorkspaceMenuView('groups')}
                      onMouseLeave={() => setWorkspaceMenuView('main')}
                    >
                      <button
                        role="menuitem"
                        aria-haspopup="menu"
                        aria-expanded={workspaceMenuView === 'groups'}
                        onClick={() => setWorkspaceMenuView('groups')}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowRight') setWorkspaceMenuView('groups');
                        }}
                      >
                        <FolderInput size={14} />
                        <span>Move to group</span>
                        <ChevronRight size={14} className="menu-chevron" />
                      </button>
                      {workspaceMenuView === 'groups' && (
                        <div className="menu-submenu" role="menu" aria-label="Move to group">
                        {groups.map((group) => (
                          <button
                            key={group}
                            role="menuitemradio"
                            aria-checked={meta.group === group}
                            onClick={() => moveWorkspaceToGroup(p.id, name, group)}
                          >
                            <FolderInput size={14} />
                            <span>{group}</span>
                            {meta.group === group && <Check size={14} className="menu-check" />}
                          </button>
                        ))}
                        {meta.group && (
                          <button
                            role="menuitem"
                            onClick={() => moveWorkspaceToGroup(p.id, name, undefined)}
                          >
                            <X size={14} />
                            <span>Remove from group</span>
                          </button>
                        )}
                        <button
                          role="menuitem"
                          onClick={() => {
                            setWorkspaceMenu(null);
                            setGroupPrompt({ projectId: p.id, name, value: '' });
                          }}
                        >
                          <Plus size={14} />
                          <span>New group…</span>
                        </button>
                            </div>
                      )}
                    </div>
                    <div className="menu-separator" role="separator" />
                    <button role="menuitem" onClick={() => archiveWorkspace(p.id, name)}>
                      {meta.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                      <span>{meta.archived ? 'Unarchive' : 'Archive'}</span>
                    </button>
                    <button
                      role="menuitem"
                      className="danger-menu-item"
                      onClick={() => {
                        setWorkspaceMenu(null);
                        deleteWorkspace(p.id, name);
                      }}
                    >
                      <Trash2 size={14} />
                      <span>Delete</span>
                    </button>
                  </>
              </AnchoredPopover>
            )}
          </AnimatePresence>
        </div>
        {!collapsedWorkspaces[`${p.id}:${name}`] &&
          terminalsForWorkspace(name).map((t) => {
            const displayTitle = displayTerminalTitle(
              t.sessionTitle,
              t.label,
              t.agentId,
            );
            const displayLabel = displayTerminalLabel(t.label, t.agentId);
            const hasSummary = displayTitle !== displayLabel;
            const isAgent = !!t.agentId && t.agentId !== 'terminal';
            const status = isAgent
              ? terminalStatus(t, agentTurns.current.get(t.id))
              : t.exited ? 'done' : 'idle';
            return (
              <button
                key={t.id}
                className={`terminal-link ${activeTerminalId === t.id ? 'active' : ''}`}
                aria-current={activeTerminalId === t.id ? 'true' : undefined}
                aria-label={`${displayTitle} (${displayLabel})`}
                onClick={() => {
                  if (workspaceName !== name) {
                    setFullScreenTerminalId(null);
                    update(p.id, (w) => ({
                      ...w,
                      activeWorkspace: name,
                      layout: 'terminal',
                    }));
                  } else setLayout('terminal');
                  activateTerminal(t.id);
                }}
                title={
                  hasSummary
                    ? `${displayTitle} · ${displayLabel}`
                    : displayLabel
                }
              >
                <span className="terminal-link-copy">
                  <strong>{displayTitle}</strong>
                  {hasSummary && <small>{displayLabel}</small>}
                </span>
                <span
                  className={`terminal-dot ${status} ${t.exited ? 'stopped' : ''}`}
                  role="img"
                  aria-label={t.exited ? 'Exited' : status === 'working' ? 'Active' : status === 'done' ? 'Complete' : 'Idle'}
                />
              </button>
            );
          })}
      </div>
    );
  }
  return (
    <MotionConfig reducedMotion={preferences.reduceMotion ? 'always' : 'never'}>
    <div className={`app mode-${mode}`}>
      <header className={`titlebar ${notificationsOpen ? 'notifications-open' : ''}`}>
        {/* Claude's leading cluster: menu, sidebar toggle, then the Code / Chat switch. It spans the
            sidebar's width so the title after it lines up with the content. */}
        <div className="titlebar-lead">
        <button
          className="titlebar-icon"
          aria-label="Commands"
          title="Commands (Ctrl K)"
          aria-haspopup="dialog"
          onClick={() => setPalette((open) => !open)}
        >
          <Menu size={16} />
        </button>
        {shownMode === 'code' ? (
          <button
            className={`titlebar-icon ${projectsPanel ? 'active' : ''}`}
            aria-label="Projects sidebar"
            title={projectsPanel ? 'Hide sidebar (Ctrl Shift B)' : 'Show sidebar (Ctrl Shift B)'}
            aria-pressed={projectsPanel}
            aria-controls="projects-sidebar"
            onClick={() => setProjectsPanel((open) => !open)}
          >
            <PanelLeft size={16} />
          </button>
        ) : (
          <button
            className={`titlebar-icon ${chatSidebar ? 'active' : ''}`}
            aria-label="Chats sidebar"
            title={chatSidebar ? 'Hide sidebar (Ctrl Shift B)' : 'Show sidebar (Ctrl Shift B)'}
            aria-pressed={chatSidebar}
            onClick={() => setChatSidebar((open) => !open)}
          >
            <PanelLeft size={16} />
          </button>
        )}
        <nav className="mode-switch" aria-label="App mode" data-mode={mode}>
          <span className="mode-switch-pill" aria-hidden="true" />
          {(['code', 'chat'] as const).map((item) => (
            <button
              key={item}
              aria-label={item[0].toUpperCase() + item.slice(1)}
              title={item[0].toUpperCase() + item.slice(1)}
              aria-pressed={mode === item}
              className={mode === item ? 'active' : ''}
              onPointerEnter={
                item === 'chat' ? () => { void loadChat().catch(() => {}); } : undefined
              }
              onClick={() => (item === 'chat' ? openChat() : setMode(item))}
            >
              {item === 'chat' ? <MessageSquare size={15} aria-hidden="true" /> : <Code2 size={15} aria-hidden="true" />}
            </button>
          ))}
        </nav>
        </div>
        {shownMode === 'chat' && <div className="chat-titlebar-slot" ref={setChatSlot} />}
        {shownMode === 'code' && (
          <div className="titlebar-title" title={project?.root}>
            <span>{project?.name || 'Veyo'}</span>
            {project && <span className="titlebar-title-sub">{workspaceName}</span>}
          </div>
        )}
        <div className="titlebar-actions">
          {shownMode === 'code' && (
            <div className="titlebar-workspace-actions" role="group" aria-label="Workspace actions">
              {!!visibleTerminals.length && (
                <button
                  className="titlebar-workspace-action"
                  title={`Close all terminals in ${workspaceName}`}
                  aria-label={`Close all terminals in ${workspaceName}`}
                  onClick={closeAllTerminals}
                >
                  <Trash2 size={16} />
                </button>
              )}
              <button
                className={`titlebar-workspace-action workspace-views-trigger ${explorer ? 'active' : ''}`}
                aria-label="Files"
                title={explorer ? 'Hide files' : 'Show files'}
                aria-pressed={explorer}
                disabled={!project}
                onClick={() => {
                  setMode('code');
                  setExplorer((open) => !open);
                  setSection('files');
                }}
              >
                <Files size={17} strokeWidth={1.6} />
              </button>
              <button
                className={`titlebar-workspace-action workspace-views-trigger ${browserOpen ? 'active' : ''}`}
                aria-label="Browser"
                title={browserOpen ? 'Close browser' : 'Open browser'}
                aria-pressed={browserOpen}
                disabled={!project}
                onClick={() => {
                  setMode('code');
                  toggleBrowser();
                }}
              >
                <Globe size={17} strokeWidth={1.6} />
              </button>
            </div>
          )}
          {shownMode === 'chat' && (
            <div className="titlebar-workspace-actions" role="group" aria-label="Chat panes">
              <button
                className={`titlebar-workspace-action workspace-views-trigger chat-pane-toggle ${chatTerminalOpen ? 'active' : ''}`}
                aria-label="Chat terminal"
                title={chatTerminalOpen ? 'Hide terminal' : 'Show terminal'}
                aria-pressed={chatTerminalOpen}
                onClick={() => setChatTerminalOpen((open) => !open)}
              >
                <SquareTerminal size={17} strokeWidth={1.6} />
              </button>
              <button
                className={`titlebar-workspace-action workspace-views-trigger chat-pane-toggle ${chatBrowserOpen ? 'active' : ''}`}
                aria-label="Chat browser"
                title={chatBrowserOpen ? 'Hide browser' : 'Show browser'}
                aria-pressed={chatBrowserOpen}
                onClick={() => setChatBrowserOpen((open) => !open)}
              >
                <Globe size={17} strokeWidth={1.6} />
              </button>
              <button
                className={`titlebar-workspace-action workspace-views-trigger chat-pane-toggle ${chatFilesOpen ? 'active' : ''}`}
                aria-label="Project files"
                title={chatFilesOpen ? 'Hide files' : 'Show files'}
                aria-pressed={chatFilesOpen}
                onClick={() => setChatFilesOpen((open) => !open)}
              >
                <FolderOpen size={17} strokeWidth={1.6} />
              </button>
            </div>
          )}
          <div className="window-controls">
            <button aria-label="Minimize" onClick={() => api.windowAction('minimize')}>
              <Minus size={14} />
            </button>
            <button aria-label="Maximize" onClick={() => api.windowAction('maximize')}>
              <Square size={11} />
            </button>
            <button aria-label="Close app" onClick={() => api.windowAction('close')}>
              <X size={15} />
            </button>
          </div>
        </div>
      </header>
      <div
        className="chat-mode-container"
        ref={chatModeRef}
        style={{ display: shownMode === 'chat' ? 'flex' : 'none' }}
      >
        {chatVisited && chatModule && (
          <chatModule.default
            projects={projects}
            activeFile={file}
            activeProject={activeProject}
            handoff={chatHandoff}
            chatDefaults={{ provider: preferences.chatProvider, permission: preferences.chatPermission }}
            preferences={displayPreferences}
            filesOpen={chatFilesOpen}
            onFilesOpenChange={setChatFilesOpen}
            terminalOpen={chatTerminalOpen}
            onTerminalOpenChange={setChatTerminalOpen}
            browserOpen={chatBrowserOpen}
            onBrowserOpenChange={setChatBrowserOpen}
            titlebarSlot={chatSlot}
            sidebarOpen={chatSidebar}
            usage={planUsage.usage}
            usageLoading={planUsage.loading}
            usageError={planUsage.error}
            onRefreshUsage={planUsage.refresh}
            onOpenFile={async (projectId, targetPath) => {
              const targetProject = projects.find((item) => item.id === projectId);
              if (!targetProject) return;
              const root = targetProject.root.replaceAll('\\', '/').replace(/\/$/, '');
              const normalized = targetPath.replaceAll('\\', '/');
              const path = normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)
                ? normalized.slice(root.length + 1) : normalized;
              try {
                const disk = await api.readFile(projectId, path);
                await api.activateProject(projectId);
                setActiveProject(projectId);
                update(projectId, (current) => {
                  const existing = current.files.find((entry) => entry.path === path);
                  const next = existing && existing.content !== existing.saved
                    ? { ...existing, conflict: existing.revision !== disk.revision ? disk : existing.conflict }
                    : { ...disk, path, saved: disk.content };
                  return { ...current, activeFile: path, layout: 'focus', files: existing
                    ? current.files.map((entry) => entry.path === path ? next : entry)
                    : [...current.files, next] };
                });
                setMode('code');
                setDashboardOpen(false);
              } catch (value) { error(value); }
            }}
          />
        )}
      </div>
      <div
        // With the explorer open, a docked dashboard stacks under it in the same column (as
        // Claude stacks its side panes) instead of taking a fourth column of its own.
        className={`app-body ${!explorerHidden && dashboardOpen && dashboardDocked ? 'stack-dock' : ''}`}
        ref={appBodyRef}
        style={{
          display: shownMode === 'code' ? undefined : 'none',
          '--dashboard-width': panelWidths.dashboard ? `${panelWidths.dashboard}px` : undefined,
        } as React.CSSProperties}
      >
        <aside
          id="projects-sidebar"
          className="projects-sidebar"
          ref={projectsPanelRef}
          style={{
            display: projectsHidden ? 'none' : undefined,
            ...(panelWidths.projects
              ? { width: panelWidths.projects, flexBasis: panelWidths.projects }
              : {}),
          }}
        >
          <nav className="sidebar-actions" aria-label="Quick actions">
            <button
              disabled={!activeProject}
              onClick={() => activeProject && createWorkspace(activeProject)}
            >
              <Plus size={16} />
              <span>New workspace</span>
            </button>
            <button disabled={!activeProject} onClick={() => setQuickOpen(true)}>
              <Search size={16} />
              <span>Find file</span>
              <kbd aria-hidden="true">Ctrl P</kbd>
            </button>
            <button
              className={dashboardOpen ? 'active' : ''}
              aria-expanded={dashboardOpen}
              aria-controls="agent-dashboard"
              onClick={() => setDashboardOpen((open) => !open)}
            >
              <LayoutDashboard size={16} />
              <span>Dashboard</span>
              {!!runningAgentCount && <small aria-hidden="true">{runningAgentCount}</small>}
            </button>
          </nav>
          <div className="projects-heading">
            <span>Projects</span>
            <button
              className="icon-button"
              aria-label="Open project"
              title="Open project"
              onClick={openProject}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="project-list">
            {projectSections.map((section) => (
              <section
                key={section.id}
                className={`project-section ${section.id === 'pinned' ? 'pinned' : ''}`}
              >
                {(section.id === 'pinned' || projectSections.length > 1) && (
                  <div className="project-section-heading">
                    {section.id === 'pinned' && <Pin size={12} aria-hidden="true" />}
                    <span>{section.title}</span>
                  </div>
                )}
                {section.projects.map((p) => (
                  <div key={p.id} className="project-group">
                    <div className="project-row-wrap">
                      <button
                        className={`project-row ${activeProject === p.id ? 'active' : ''}`}
                        aria-label={p.pinned ? `${p.name}, pinned project` : p.name}
                        title={p.root}
                        onClick={() => switchProject(p.id)}
                      >
                        <span>{p.name}</span>
                      </button>
                      <button
                        className={`project-collapse ${activeProject !== p.id || collapsedProjects[p.id] ? 'collapsed' : ''}`}
                        aria-label={`${activeProject === p.id && !collapsedProjects[p.id] ? 'Hide' : 'Show'} workspaces in ${p.name}`}
                        aria-expanded={activeProject === p.id && !collapsedProjects[p.id]}
                        title={`${activeProject === p.id && !collapsedProjects[p.id] ? 'Hide' : 'Show'} workspaces`}
                        onClick={() => {
                          if (activeProject !== p.id) {
                            setCollapsedProjects((previous) => ({ ...previous, [p.id]: false }));
                            void switchProject(p.id);
                          } else {
                            setCollapsedProjects((previous) => ({ ...previous, [p.id]: !previous[p.id] }));
                          }
                        }}
                      >
                        <ChevronDown size={15} />
                      </button>
                      <button
                        className="project-add"
                        aria-label={`New workspace in ${p.name}`}
                        title="New workspace"
                        onClick={() => createWorkspace(p.id)}
                      >
                        <Plus size={15} />
                      </button>
                      <button
                        className="menu-trigger"
                        aria-label={`More options for ${p.name}`}
                        aria-haspopup="menu"
                        aria-expanded={projectMenu === p.id}
                        title="Project options"
                        onClick={(event) => {
                          setWorkspaceMenu(null);
                          setMenuAnchor(event.currentTarget);
                          setProjectMenu((current) => (current === p.id ? null : p.id));
                        }}
                      >
                        <SlidersHorizontal size={15} />
                      </button>
                      <AnimatePresence>
                        {projectMenu === p.id && (
                          <AnchoredPopover anchor={menuAnchor} className="context-menu" role="menu">
                            <button role="menuitem" onClick={() => createWorkspace(p.id)}>
                              <Plus size={14} />
                              New workspace
                            </button>
                            <button role="menuitem" onClick={() => toggleProjectPin(p)}>
                              {p.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                              {p.pinned ? 'Unpin project' : 'Pin project'}
                            </button>
                            <button
                              role="menuitem"
                              className="danger-menu-item"
                              onClick={() => {
                                setProjectMenu(null);
                                deleteProject(p);
                              }}
                            >
                              <Trash2 size={14} />
                              Remove project
                            </button>
                          </AnchoredPopover>
                        )}
                      </AnimatePresence>
                    </div>
                    {activeProject === p.id && !collapsedProjects[p.id] && (
                      <div
                        className="workspace-list"
                        onDragOver={(event) => {
                          if (!dragWorkspace || dragWorkspace.projectId !== p.id) return;
                          // Anywhere outside a group's own block takes the workspace out of its group.
                          if (!work?.workspaceMeta?.[dragWorkspace.name]?.group) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'move';
                        }}
                        onDrop={(event) => {
                          if (!dragWorkspace || dragWorkspace.projectId !== p.id) return;
                          if (!work?.workspaceMeta?.[dragWorkspace.name]?.group) return;
                          event.preventDefault();
                          const name = dragWorkspace.name;
                          setDropSection(null);
                          setDragWorkspace(null);
                          moveWorkspaceToGroup(p.id, name, undefined);
                        }}
                      >
                        {(() => {
                          const { sections, archived } = workspaceSections(
                            work?.workspaceNames || ['Main'],
                            work?.workspaceMeta,
                          );
                          return (
                            <>
                              {sections.map((section) => (
                                <div
                                  key={section.id}
                                  className={`workspace-section${dropSection === section.id ? ' drop-target' : ''}`}
                                  onDragOver={(event) => {
                                    if (!dragWorkspace || dragWorkspace.projectId !== p.id || section.id === 'pinned') return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    event.dataTransfer.dropEffect = 'move';
                                    if (dropSection !== section.id) setDropSection(section.id);
                                  }}
                                  onDragLeave={(event) => {
                                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropSection(null);
                                  }}
                                  onDrop={(event) => {
                                    if (!dragWorkspace || dragWorkspace.projectId !== p.id || section.id === 'pinned') return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    const target = section.title || undefined;
                                    const current = work?.workspaceMeta?.[dragWorkspace.name]?.group;
                                    setDropSection(null);
                                    setDragWorkspace(null);
                                    if (current !== target) moveWorkspaceToGroup(p.id, dragWorkspace.name, target);
                                  }}
                                >
                                  {section.title && (
                                    <div className="workspace-group-heading">{section.title}</div>
                                  )}
                                  {section.names.map((name) => renderWorkspace(p, name))}
                                </div>
                              ))}
                              {archived.length > 0 && (
                                <div className="workspace-section workspace-archived">
                                  <button
                                    className="workspace-archived-toggle"
                                    aria-expanded={!!showArchived[p.id]}
                                    onClick={() =>
                                      setShowArchived((previous) => ({
                                        ...previous,
                                        [p.id]: !previous[p.id],
                                      }))
                                    }
                                  >
                                    <Archive size={13} />
                                    <span>Archived</span>
                                    <small>{archived.length}</small>
                                    <ChevronDown size={13} className="workspace-archived-chevron" />
                                  </button>
                                  {showArchived[p.id] && archived.map((name) => renderWorkspace(p, name))}
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                ))}
              </section>
            ))}
            {!projects.length && (
              <p className="inset muted">Open a project folder to start a workspace.</p>
            )}
          </div>
          <button className="sidebar-settings" onClick={() => setSettings(true)}>
            <SettingsGear size={15} aria-hidden="true" />
            Settings
          </button>
        </aside>
        {!projectsHidden && panelSeparator('projects', 'Resize projects panel')}
        <aside
          className="sidebar workspace-sidebar"
          ref={explorerPanelRef}
          style={{
            display: explorerHidden ? 'none' : undefined,
            width: panelWidths.explorer,
            flexBasis: panelWidths.explorer,
          }}
        >
          <nav className="sidebar-nav" aria-label="Workspace files">
            {(
              [
                { id: 'files', label: 'Explorer', icon: Files },
                { id: 'search', label: 'Find files', icon: Search },
                { id: 'git', label: 'Changes', icon: GitBranch },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                className={section === item.id ? 'active' : ''}
                onClick={() => setSection(item.id)}
              >
                <item.icon size={15} />
                <span className="sidebar-nav-label">{item.label}</span>
                {item.id === 'git' && git.files.length > 0 && (
                  <span className="count">{git.files.length}</span>
                )}
              </button>
            ))}
          </nav>
          {section !== 'files' && (
          <div className="sidebar-section-title">
            <div>
              <span>
                {section === 'git' ? 'Source control' : 'Search project'}
              </span>
              <small>
                {section === 'git'
                  ? 'Review, stage and commit changes'
                  : 'Find files or text in this project'}
              </small>
            </div>
            <button
              className="icon-button"
              title="Refresh files and Git"
              aria-label="Refresh files"
              onClick={() => setRefresh((n) => n + 1)}
            >
              <RefreshCw size={12} />
            </button>
          </div>
          )}
          <div className="sidebar-content">
            {!project ? (
              <div className="sidebar-empty">
                <FolderOpen size={24} />
                <p>Open a folder to explore your project.</p>
                <button className="text-button" onClick={openProject}>
                  Open folder <ArrowRight size={13} />
                </button>
              </div>
            ) : (
              <ProjectTools
                key={project.id}
                project={project}
                section={section}
                refresh={refresh}
                files={work?.files || []}
                active={file?.path}
                git={git}
                onOpen={openFile}
                onError={error}
                onChanged={() => setRefresh((n) => n + 1)}
                onClose={() => setExplorer(false)}
                onRename={(previous, next) =>
                  update(project.id, (current) => {
                    const rename = (path: string) =>
                      path === previous || path.startsWith(`${previous}/`)
                        ? next + path.slice(previous.length)
                        : path;
                    return {
                      ...current,
                      activeFile: current.activeFile ? rename(current.activeFile) : undefined,
                      files: current.files.map((item) => ({ ...item, path: rename(item.path) })),
                    };
                  })
                }
                onTrash={(path) =>
                  update(project.id, (current) => {
                    const files = current.files.filter(
                      (item) => item.path !== path && !item.path.startsWith(`${path}/`),
                    );
                    return {
                      ...current,
                      files,
                      activeFile: files.some((item) => item.path === current.activeFile)
                        ? current.activeFile
                        : files.at(-1)?.path,
                    };
                  })
                }
              />
            )}
          </div>
        </aside>
        {!explorerHidden && panelSeparator('explorer', 'Resize explorer panel')}
        {/* The project and workspace names sit in the title bar, like Claude's session title. */}
        <main className="workspace" ref={workspaceRef}>
          <div
            ref={workAreaRef}
            className={[
              'work-area',
              !browserHidden && 'browser-side-open',
              !browserHidden && browserFullscreen && 'browser-fullscreen',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <div className="work-left-column">
              {work?.layout !== 'terminal' && (
                <div className="editor-and-preview">
                  <section className="editor-region">
                    {!!work?.files.length && (
                      <FileTabs files={work.files} active={work.activeFile} busy={busy}
                        onSelect={(path) => update(project!.id, (w) => ({ ...w, activeFile: path }))}
                        onClose={closeFile} onSaveAll={() => void saveAllFiles()} />
                    )}
                    {file ? (
                      !editorModule ? <span className="muted inset editor-loading">Loading editor…</span> :
                      <editorModule.FileEditor projectId={project!.id} file={file} preferences={displayPreferences}
                        busy={busy} editorRef={editorRef} reveal={revealTarget}
                        onChange={(content) => updateFile(project!.id, file.path, (current) => ({ ...current, content }))}
                        onSave={(keepMine) => void saveFile(keepMine)} onAsk={askAboutFile}
                        onWrap={() => updatePreferences({ ...preferences, wordWrap: !preferences.wordWrap })}
                        onUseDisk={() => {
                          void requestConfirm('Use the disk version?', 'Your unsaved edits in this file will be replaced by the version on disk.', 'Use disk version').then((confirmed) => {
                            if (confirmed) updateFile(project!.id, file.path, (current) => current.conflict
                              ? { ...current, ...current.conflict, saved: current.conflict.content, conflict: undefined } : current);
                          });
                        }} />
                    ) : (
                      <div className="welcome">
                        <div className="welcome-eyebrow">
                          <span className="status-dot" />
                          {project ? 'Workspace ready' : 'Your local coding space'}
                        </div>
                        <div className="welcome-mark">
                          <Zap size={38} strokeWidth={1.25} />
                        </div>
                        <h1>{project ? project.name : 'Open your workspace'}</h1>
                        <p>
                          {project
                            ? 'Open a file, start a terminal, and pick up where you left off.'
                            : 'Your code, terminals, and projects. One workspace.'}
                        </p>
                        <button
                          className="primary-button"
                          onClick={project ? () => setAgentLauncher(true) : openProject}
                        >
                          {project ? <SquareTerminal size={16} /> : <FolderOpen size={16} />}
                          {project ? 'Choose agents & terminals' : 'Open a project'}
                          <ArrowRight size={16} />
                        </button>
                        <div className="welcome-shortcuts">
                          <div>
                            <span>Open project</span>
                            <kbd>Ctrl O</kbd>
                          </div>
                          <div>
                            <span>Command palette</span>
                            <kbd>Ctrl K</kbd>
                          </div>
                          <div>
                            <span>New terminal</span>
                            <kbd>Ctrl `</kbd>
                          </div>
                        </div>
                        <div className="welcome-bottom">
                          {project ? project.root : 'Start with any folder on your computer.'}
                        </div>
                      </div>
                    )}
                  </section>
                </div>
              )}
              {work && showTerminalSection && (
                <>
                  {visibleTerminals.length > 0 && work.layout === 'build' && (
                    <div
                      className="resize-handle"
                      onPointerDown={resizeTerminals}
                      role="separator"
                      aria-label="Resize terminals"
                      aria-orientation="horizontal"
                      tabIndex={0}
                      aria-valuemin={160}
                      aria-valuemax={Math.max(160, window.innerHeight - 300)}
                      aria-valuenow={work.terminalHeight}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                          event.preventDefault();
                          update(project!.id, (current) => ({
                            ...current,
                            terminalHeight: Math.max(
                              160,
                              Math.min(
                                window.innerHeight - 300,
                                current.terminalHeight + (event.key === 'ArrowUp' ? 20 : -20),
                              ),
                            ),
                          }));
                        }
                      }}
                    />
                  )}
                  <section
                    className={`terminal-section ${work.layout === 'terminal' ? 'full' : ''}`}
                    style={work.layout === 'terminal' ? undefined : { height: work.terminalHeight }}
                  >
                    {visibleTerminals.length ? (
                      <div
                        className={`terminal-grid ${terminalColumnCount === 1 ? 'single-column' : ''} ${draggingTerminalId ? 'reordering' : ''}`}
                        ref={terminalGridRef}
                        style={{
                          gridTemplateColumns: `repeat(${terminalGridTrackCount}, minmax(0, 1fr))`,
                          gridAutoRows:
                            work.layout === 'terminal' ? 'minmax(240px, 1fr)' : 'minmax(190px, 1fr)',
                        }}
                      >
                        <p className="sr-only" aria-live="polite">
                          {draggingTerminalId
                            ? `Moving ${displayTerminalTitle(
                                draggingTerminal?.sessionTitle,
                                draggingTerminal?.label || 'terminal',
                                draggingTerminal?.agentId,
                              )} to position ${
                                terminalViews.findIndex((t) => t.id === draggingTerminalId) + 1
                              } of ${terminalViews.length}. Release to drop, Escape to cancel.`
                            : ''}
                        </p>
                        {terminalViews.map((t, index) => {
                          const fillsLastRow =
                            work.layout === 'terminal' &&
                            terminalGridRemainder > 0 &&
                            index >= terminalGridLastRowStart;
                          const gridColumnSpan =
                            work.layout === 'terminal'
                              ? fillsLastRow
                                ? terminalGridTrackCount / terminalGridRemainder
                                : 2
                              : undefined;
                          return (
                            <TerminalPane
                              preferences={displayPreferences}
                              key={t.id}
                              gridColumnSpan={gridColumnSpan}
                              info={t}
                              isFullScreen={fullScreenTerminalId === t.id}
                              isActive={activeTerminalId === t.id}
                              beaconNonce={beacon?.id === t.id ? beacon.nonce : undefined}
                              onActivate={() => setActiveTerminalId(t.id)}
                              onInput={(data) => recordTerminalInput(t, data)}
                              onFullScreen={() => toggleTerminalFullscreen(t.id)}
                              onNewPane={(event) => toggleNewPaneMenu(event, t.id)}
                              newPaneMenuOpen={newPaneMenu?.trigger === t.id}
                              onClose={() => closeTerminal(t)}
                              onExit={(id, code) => {
                                recordTerminalExit(id, code, t);
                                update(t.projectId, (w) => ({
                                  ...w,
                                  terminals: w.terminals.map((term) =>
                                    term.id === id ? { ...term, exited: true, exitCode: code } : term,
                                  ),
                                }));
                              }}
                              onError={error}
                              canMove={!fullScreenTerminalId && terminalViews.length > 1}
                              moveState={draggingTerminalId === t.id ? 'dragging' : undefined}
                              onMoveKey={(key) => moveTerminalBy(t.id, key)}
                              dragHandlers={reorder.headerProps(t.id)}
                            />
                          );
                        })}
                      </div>
                    ) : (
                      <AgentPicker
                        key={`${project!.id}:${workspaceName}`}
                        projectId={project!.id}
                        projectName={project?.name || 'your project'}
                        projectPath={project?.root || ''}
                        workspaceName={workspaceName}
                        gitAvailable={git.available}
                        presetSelections={reusablePresetSelections}
                        onSelect={(selections) => addAgentTerminals(selections)}
                        onNotify={(text, action) => {
                          setToastAction(action ? { text, ...action } : null);
                          setToast(text);
                        }}
                      />
                    )}
                  </section>
                </>
              )}
            </div>
            {!browserHidden &&
              !browserFullscreen &&
              panelSeparator('browser', 'Resize browser panel')}
            {browserMounted && (
              <WorkspaceBrowser
                key={browserSession}
                isFullscreen={browserFullscreen}
                style={
                  browserHidden
                    ? { display: 'none' }
                    : browserFullscreen
                      ? undefined
                      : {
                          width: browserPanelWidth,
                          flexBasis: browserPanelWidth,
                          minWidth: browserPanelMinWidth,
                        }
                }
                onClose={closeBrowser}
                onSendToAgent={sendBrowserPrompt}
                onToggleFullscreen={() => setBrowserFullscreen((fullscreen) => !fullscreen)}
              />
            )}
          </div>
        </main>
        <AnimatePresence onExitComplete={settleDashboardLayout}>
          {dashboardOpen && (
            <motion.div
              key="agent-dashboard-drawer"
              className={`dashboard-drawer ${dashboardDocked ? 'docked' : 'overlay'}`}
              initial={
                motionReduced()
                  ? false
                  : dashboardDocked
                    ? { width: 0, opacity: 0 }
                    : { opacity: 0, x: 20 }
              }
              animate={
                dashboardDocked
                  ? { width: dashboardDrawerWidth, opacity: 1 }
                  : { opacity: 1, x: 0 }
              }
              style={dashboardDocked ? { width: dashboardDrawerMotionWidth } : undefined}
              exit={
                dashboardDocked
                  ? { width: 0, opacity: 0, pointerEvents: 'none' }
                  : motionReduced()
                    ? { opacity: 0, x: 0, pointerEvents: 'none' }
                    : { opacity: 0, x: 20, pointerEvents: 'none' }
              }
              transition={{
                duration: motionReduced() ? 0 : 0.22,
                ease: [0.16, 1, 0.3, 1],
              }}
              onAnimationComplete={settleDashboardLayout}
            >
              {panelSeparator('dashboard', 'Resize dashboard panel')}
              <AgentDashboard
                projects={projects}
                activeProject={activeProject}
                terminals={Object.values(workspaces).flatMap((current) => current.terminals)}
                activity={agentActivity.current}
                turns={agentTurns.current}
                now={dashboardNow}
                usage={planUsage.usage}
                usageLoading={planUsage.loading}
                usageError={planUsage.error}
                onRefreshUsage={planUsage.refresh}
                onOpen={openDashboardAgent}
                onNewAgent={() => setAgentLauncher(true)}
                onOpenProject={openProject}
                onClose={() => setDashboardOpen(false)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {/* A new message waits for the old toast to leave rather than overlapping it. */}
      <AnimatePresence mode="wait">
        {toast && (
          <motion.div
            {...surfaceMotion('toast')}
            key={toast}
            className={`toast ${toastIsError(toast) ? 'toast-error' : 'toast-success'}`}
            role={toastIsError(toast) ? 'alert' : 'status'}
          >
            <Surface kind="toast" />
            {toastIsError(toast) ? (
              <AlertCircle size={15} className="toast-icon" />
            ) : (
              <Check size={15} className="toast-icon" />
            )}
            <span>{toast}</span>
            {toastAction?.text === toast && (
              <button
                className="toast-action"
                onClick={() => {
                  toastAction.run();
                  setToast('');
                }}
              >
                {toastAction.label}
              </button>
            )}
            <button
              className="icon-button toast-dismiss"
              aria-label="Dismiss notification"
              onClick={() => setToast('')}
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {newPaneMenu && project && (
          <NewPaneMenu
            key={newPaneMenu.trigger}
            projectId={project.id}
            projectPath={project.root}
            workspaceName={workspaceName}
            anchor={newPaneMenu.anchor}
            onClose={closeNewPaneMenu}
            onTerminal={() => addTerminal()}
            onFiles={() => {
              setMode('code');
              setExplorer(true);
              setSection('files');
              setLayout('build');
            }}
            onBrowser={() => {
              setMode('code');
              openBrowser();
            }}
            onAgent={(agent) => addTerminal(undefined, undefined, agent.id)}
            onMoreOptions={() => setAgentLauncher(true)}
            onNewWorkspace={() => createWorkspace(project.id)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {runCommands && project && (
          <RunCommands
            key={project.id}
            projectId={project.id}
            shells={shells}
            onClose={() => setRunCommands(false)}
            pluginCommands={pluginContributions.commands}
            onRunPlugin={startPluginCommand}
            onRun={async (command, name, shell) => {
              const next = await api.createTerminal(project.id, shell, workspaceName);
              update(project.id, (current) => ({
                ...current,
                layout: 'terminal',
                terminals: [...current.terminals, { ...next, label: name, sessionTitle: name }],
              }));
              setMode('code');
              setActiveTerminalId(next.id);
              await api.writeTerminal(next.id, command.replace(/\r?\n/g, '\r') + '\r');
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {agentLauncher && project && (
          <AgentLauncher
            key={`${project.id}:${workspaceName}`}
            projectId={project.id}
            projectName={project.name}
            workspaceName={workspaceName}
            shells={shells}
            onClose={() => setAgentLauncher(false)}
            onLaunched={(created) => {
              if (!created.length) return;
              update(created[0].projectId, (w) => ({
                ...w,
                layout: w.layout === 'focus' ? 'terminal' : w.layout,
                terminals: [...w.terminals, ...created.map((t) => ({ ...t, workspaceName }))],
              }));
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {closingFile && (
          <Modal title={`Save changes to ${baseName(closingFile.path)}?`} onClose={() => { if (!savingFile.current) setClosingFile(null); }}>
            <p className="file-close-path">{closingFile.path}</p>
            <p>Save your edits before closing this file.</p>
            <div className="tool-actions file-operation-actions">
              <button className="text-button" disabled={busy} onClick={() => setClosingFile(null)}>Cancel</button>
              <button className="danger-button" disabled={busy} onClick={() => { removeFile(closingFile.projectId, closingFile.path); setClosingFile(null); }}>Discard changes</button>
              <button className="primary-button" disabled={busy} onClick={async () => {
                const target = closingFile;
                if (await saveFile(false, target.projectId, target.path)) {
                  removeFile(target.projectId, target.path, true);
                  setClosingFile(null);
                } else {
                  setClosingFile(null);
                  update(target.projectId, (w) => ({ ...w, activeFile: target.path }));
                }
              }}>Save and close</button>
            </div>
          </Modal>
        )}
        {confirmRequest && (
          <Backdrop
            className="modal-backdrop confirm-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) finishConfirm(false);
            }}
          >
            <MotionDialog
              className="confirm-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirm-title"
              aria-describedby="confirm-detail"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="confirm-copy">
                <h2 id="confirm-title">{confirmRequest.message}</h2>
                <p id="confirm-detail">{confirmRequest.detail}</p>
              </div>
              <div className="confirm-actions">
                <button className="secondary-button" autoFocus onClick={() => finishConfirm(false)}>
                  Cancel
                </button>
                <button className="danger-button" onClick={() => finishConfirm(true)}>
                  {confirmRequest.action}
                </button>
              </div>
            </MotionDialog>
          </Backdrop>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {quickOpen && project && (
          <QuickOpen
            key={project.id}
            projectId={project.id}
            openFiles={work?.files || []}
            onClose={() => setQuickOpen(false)}
            onCommands={() => {
              setQuickOpen(false);
              setPalette(true);
            }}
            onOpen={(path) => {
              setMode('code');
              openFile(path);
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {palette && (
          <CommandPalette commands={allCommands} onClose={() => setPalette(false)} />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {settings && (
          <Settings
            shells={boot?.shells || []}
            value={preferences}
            onChange={updatePreferences}
            error={preferencesError}
            onClose={() => setSettings(false)}
            commands={allCommands.filter((c) => c.label !== 'Workspace settings')}
            pluginThemes={pluginContributions.themes}
            onOpenPlugins={() => {
              setSettings(false);
              setPluginsOpen(true);
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {pluginsOpen && pluginsModule && (
          <pluginsModule.default
            projectId={project?.id ?? null}
            projectName={project?.name}
            workspaceName={workspaceName}
            onClose={() => setPluginsOpen(false)}
            onToast={(text, action) => {
              setToastAction(action ? { text, ...action } : null);
              setToast(text);
            }}
            onTerminal={(list) => {
              setPluginsOpen(false);
              for (const info of list) showPluginTerminal(info);
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {pluginPrompt && (
          <PluginPrompt
            prompt={pluginPrompt}
            canChat={!!project}
            terminalTarget={promptTarget ? displayTerminalTitle(promptTarget.sessionTitle, promptTarget.label, promptTarget.agentId) : undefined}
            onClose={() => setPluginPrompt(null)}
            onInsertChat={(draft) => {
              if (!project) return;
              setChatHandoff({ id: crypto.randomUUID(), projectId: project.id, draft, attachActiveFile: false });
              openChat();
            }}
            onTypeTerminal={typePluginPrompt}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {workspaceRename && (
          <Backdrop
            className="modal-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setWorkspaceRename(null);
            }}
          >
            <MotionDialog
              as="form"
              className="settings-modal rename-workspace-modal"
              onSubmit={(event) => {
                event.preventDefault();
                saveWorkspaceRename();
              }}
            >
              <div className="modal-title">
                <h2>Rename workspace</h2>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Cancel workspace rename"
                  onClick={() => setWorkspaceRename(null)}
                >
                  <X size={18} />
                </button>
              </div>
              <p className="muted">Give this workspace a name you can recognize at a glance.</p>
              <input
                className="text-input"
                aria-label="Workspace name"
                autoFocus
                maxLength={40}
                value={workspaceRename.value}
                onChange={(event) =>
                  setWorkspaceRename({ ...workspaceRename, value: event.target.value })
                }
              />
              <button className="primary-button" type="submit">
                Save name
              </button>
            </MotionDialog>
          </Backdrop>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {groupPrompt && (
          <Backdrop
            className="modal-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setGroupPrompt(null);
            }}
          >
            <MotionDialog
              as="form"
              className="settings-modal rename-workspace-modal"
              aria-label="New group"
              onSubmit={(event) => {
                event.preventDefault();
                saveGroupPrompt();
              }}
            >
              <div className="modal-title">
                <h2>New group</h2>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Cancel new group"
                  onClick={() => setGroupPrompt(null)}
                >
                  <X size={18} />
                </button>
              </div>
              <p className="muted">
                Move “{groupPrompt.name}” into a new group. Groups show as headings in the sidebar.
              </p>
              <input
                className="text-input"
                aria-label="Group name"
                autoFocus
                maxLength={40}
                placeholder="e.g. Frontend"
                value={groupPrompt.value}
                onChange={(event) => setGroupPrompt({ ...groupPrompt, value: event.target.value })}
              />
              <button className="primary-button" type="submit">
                Create group
              </button>
            </MotionDialog>
          </Backdrop>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {diff && (
          <Backdrop className="modal-backdrop">
            <MotionDialog className="diff-modal" role="dialog" aria-label="Git diff">
              <div className="modal-title">
                <h2>{diff.path}</h2>
                <button
                  className="icon-button"
                  aria-label="Close diff"
                  onClick={() => setDiff(null)}
                >
                  <X size={18} />
                </button>
              </div>
              <pre>
                {diff.text ||
                  'No tracked diff available. Untracked files can be opened in the explorer.'}
              </pre>
            </MotionDialog>
          </Backdrop>
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
}
