export type Project = { id: string; name: string; root: string; pinned?: boolean };
export type Entry = { name: string; path: string; directory: boolean };
export type DiskFile = { content: string; revision: string };
export type OpenFile = DiskFile & { path: string; saved: string; conflict?: DiskFile };
export type TerminalInfo = {
  workspaceName?: string;
  agentId?: string;
  id: string;
  projectId: string;
  label: string;
  shell: string;
  sessionTitle?: string;
  exited?: boolean;
  exitCode?: number;
  startedAt?: number;
  lastOutputAt?: number;
  lastInputAt?: number;
  finishedAt?: number;
};
export type TerminalEvent = {
  id: string;
  seq: number;
  data?: string;
  exitCode?: number;
  at?: number;
};
export type GitStatus = {
  error?: string;
  available: boolean;
  branch: string;
  files: { path: string; status: string; originalPath?: string }[];
};
export type Layout = 'focus' | 'terminal' | 'build';
export type WorkspaceMeta = {
  pinned?: boolean;
  unread?: boolean;
  archived?: boolean;
  group?: string;
};
export type SavedSession = {
  workspaceNames?: string[];
  workspaceMeta?: Record<string, WorkspaceMeta>;
  activeWorkspace?: string;
  files: OpenFile[];
  activeFile?: string;
  layout: Layout;
  terminalHeight: number;
  terminalPresets?: {
    terminalId?: string;
    label: string;
    shell: string;
    agentId?: string;
    workspaceName?: string;
    sessionTitle?: string;
  }[];
};
export type RunPreset = { name: string; command: string };
export type SavedChatState = {
  threads: unknown[];
  active: string | null;
  settings: {
    endpoint?: string;
    model?: string;
    effort?: string;
    provider?: string;
    permission?: string;
    modelEfforts?: Record<string, string>;
  };
};
export type ContentMatch = { path: string; line: number; column: number; text: string };
export type ChatAttachment = {
  id: string;
  name: string;
  kind: 'image' | 'text';
  mimeType: string;
  size: number;
};
export type ChatAttachmentInput = {
  name: string;
  kind: 'image' | 'text';
  mimeType: string;
  data: string;
  content?: string;
};
export type ChatFileChange = {
  path: string;
  kind: 'add' | 'update' | 'delete';
  additions: number;
  deletions: number;
  diff: string;
  truncated?: boolean;
};
export type ChatActivity = {
  id: string;
  kind: 'command' | 'file' | 'tool';
  title: string;
  detail?: string;
  status: 'running' | 'completed' | 'failed';
  paths?: string[];
  changes?: ChatFileChange[];
};
export type ChatMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: ChatAttachment[];
  activities?: ChatActivity[];
};
export type ChatModel = {
  id: string;
  name: string;
  efforts?: string[];
  defaultEffort?: string;
  isDefault?: boolean;
};
export type Bootstrap = {
  terminals?: TerminalInfo[];
  projects: Project[];
  activeProject: string | null;
  sessions: Record<string, SavedSession>;
  shells: { id: string; label: string }[];
  launchProject?: string | null;
};
export interface WorkspaceAPI {
  activateProject(id: string): Promise<void>;
  renameWorkspace(id: string, previous: string, next: string): Promise<void>;
  createEntry(id: string, path: string, directory: boolean): Promise<Entry>;
  renameEntry(id: string, path: string, next: string): Promise<void>;
  trashEntry(id: string, path: string): Promise<void>;
  searchContent(
    id: string,
    query: string,
    sensitive: boolean,
  ): Promise<{ matches: ContentMatch[]; truncated: boolean }>;
  gitStage(id: string, path: string): Promise<void>;
  gitUnstage(id: string, path: string): Promise<void>;
  gitCommit(id: string, message: string): Promise<string>;
  chatModels(
    provider: 'ollama' | 'codex' | 'claude',
    endpoint: string,
    fresh?: boolean,
  ): Promise<ChatModel[]>;
  chatSend(request: {
    id: string;
    provider: 'ollama' | 'codex' | 'claude';
    permission: 'ask' | 'auto' | 'edits' | 'plan' | 'full';
    projectId: string;
    prompt: string;
    sessionId?: string;
    attachments?: ChatAttachment[];
    endpoint: string;
    model: string;
    effort?: string;
    messages: ChatMessage[];
  }): Promise<{
    text: string;
    sessionId: string | null;
    activities?: ChatActivity[];
    error?: string;
  }>;
  chatCancel(id: string): Promise<void>;
  chatStoreAttachments(files: ChatAttachmentInput[]): Promise<ChatAttachment[]>;
  chatReadAttachment(id: string): Promise<ChatAttachmentInput>;
  onChatActivity(callback: (event: { id: string; activity: ChatActivity }) => void): () => void;
  onChatSession(callback: (event: { id: string; sessionId: string }) => void): () => void;
  chatApproval(id: string, allowed: boolean): Promise<void>;
  onChatApproval(
    callback: (approval: { id: string; requestId: string; title: string; detail: string }) => void,
  ): () => void;
  voiceListen(): Promise<string>;
  voiceSpeak(text: string): Promise<void>;
  voiceStop(): Promise<void>;
  onChatChunk(callback: (chunk: { id: string; text: string }) => void): () => void;
  /**
   * Plan usage for signed-in Claude Code and Codex CLIs. 'cached' returns what is
   * already held without a request; 'force' skips the short cache.
   */
  getUsage(mode?: 'cached' | 'force'): Promise<Partial<Record<UsageProvider, PlanUsage>>>;
  onUsageChanged?(callback: () => void): () => void;
  openExternal(url: string): Promise<void>;
  onBeforeClose(callback: () => void): () => void;
  listAgents(
    projectId: string,
    workspaceName: string,
    fresh?: boolean,
  ): Promise<{ agents: AgentOption[]; remaining: number }>;
  launchAgents(
    id: string,
    selections: { agentId: string; count: number }[],
    shell?: string,
    workspaceName?: string,
  ): Promise<{ created: TerminalInfo[]; errors: string[] }>;
  bootstrap(): Promise<Bootstrap>;
  pickProject(): Promise<Project | null>;
  removeProject(id: string): Promise<string | null>;
  updateProject(id: string, patch: { pinned?: boolean }): Promise<Project>;
  claudeSettings(id: string): Promise<{ decision: 'trusted' | 'ignored' | null; files: string[] }>;
  setClaudeSettings(id: string, decision: 'trusted' | 'ignored'): Promise<void>;
  listFiles(id: string, path?: string, includeIgnored?: boolean): Promise<Entry[]>;
  searchFiles(id: string, query: string): Promise<Entry[]>;
  readFile(id: string, path: string): Promise<DiskFile>;
  saveFile(
    id: string,
    path: string,
    content: string,
    revision: string,
  ): Promise<{ conflict: boolean; revision: string; content?: string }>;
  gitStatus(id: string): Promise<GitStatus>;
  gitDiff(id: string, path: string, staged?: boolean): Promise<string>;
  saveSession(id: string, value: SavedSession): Promise<void>;
  /** null when this project's presets have never been saved here. */
  pluginsState(projectId?: string | null): Promise<PluginsState>;
  pluginsContributions(projectId?: string | null): Promise<PluginContributions>;
  pluginsDetails(key: string): Promise<{ key: string; plugin?: PluginDetail; error?: string }>;
  /** A folder chosen in the system dialog, or null. */
  pluginsPickFolder(): Promise<string | null>;
  /** Stages and validates a plugin; nothing is installed until pluginsInstall. */
  pluginsPreview(request: PluginPreviewRequest): Promise<PluginPreview>;
  pluginsCancelPreview(previewId: string): Promise<void>;
  pluginsInstall(
    previewId: string,
    scope: 'user' | 'project',
    projectId?: string,
  ): Promise<{ key: string; id: string; version: string }>;
  pluginsSetEnabled(key: string, enabled: boolean): Promise<void>;
  pluginsUninstall(key: string): Promise<void>;
  pluginsCatalog(): Promise<PluginCatalog>;
  /** A Git address, GitHub owner/repo, or an absolute folder path. */
  pluginsAddMarketplace(input: string): Promise<PluginMarketplace>;
  pluginsRefreshMarketplace(name: string): Promise<void>;
  /** Installed plugins from the marketplace stay installed. */
  pluginsRemoveMarketplace(name: string): Promise<void>;
  /** The exact command that would add a plugin's MCP server to a coding CLI. */
  pluginsMcpPlan(
    projectId: string,
    pluginKey: string,
    server: string,
    cli: McpCli,
    /** `scope` applies when planning a plugin under review ("preview:<id>"). */
    options?: { clientId?: string; scope?: 'user' | 'project' },
  ): Promise<McpPlan>;
  /** Runs that command in a visible terminal; the connection is recorded if the CLI succeeds. */
  pluginsMcpAdd(
    projectId: string,
    pluginKey: string,
    server: string,
    cli: McpCli,
    options?: { clientId?: string },
    workspaceName?: string,
  ): Promise<TerminalInfo>;
  /** Browser sign-in for an OAuth server, run by the CLI in a terminal. */
  pluginsMcpLogin(projectId: string, pluginKey: string, server: string, cli: McpCli, workspaceName?: string): Promise<TerminalInfo>;
  /** Removes a server Veyo added to a CLI, in a terminal. */
  pluginsMcpRemove(projectId: string, pluginKey: string, cli: McpCli, name: string, workspaceName?: string): Promise<TerminalInfo>;
  /** Fetches Veyo's built-in catalog again (for example after being offline). */
  pluginsRefreshPublic(): Promise<void>;
  /** Opens a visible terminal running the plugin command named by its namespaced key. */
  pluginsRunCommand(projectId: string, key: string, workspaceName?: string): Promise<TerminalInfo>;
  onPluginsChanged(callback: () => void): () => void;
  updateState(): Promise<UpdateState>;
  updateCheck(): Promise<UpdateState>;
  updateInstall(): Promise<void>;
  onUpdateState(callback: (state: UpdateState) => void): () => void;
  getRunPresets(id: string): Promise<RunPreset[] | null>;
  saveRunPresets(id: string, presets: RunPreset[]): Promise<void>;
  /** null when chats have never been saved here. */
  getChatState(): Promise<SavedChatState | null>;
  saveChatState(value: SavedChatState): Promise<void>;
  createTerminal(id: string, shell?: string, workspaceName?: string): Promise<TerminalInfo>;
  attachTerminal(
    id: string,
    workspaceName?: string,
  ): Promise<{ output: string; seq: number; exited: boolean; exitCode?: number }>;
  writeTerminal(id: string, data: string): Promise<void>;
  setCodexFullAccess(id: string): Promise<void>;
  readTerminalClipboard(): Promise<{ text: string; hasImage: boolean }>;
  writeTerminalClipboard(text: string): Promise<void>;
  pathForFile(file: File): string;
  // Both resolve to the saved image's path.
  saveDroppedImage(image: { name: string; data: string }): Promise<string>;
  downloadDroppedImage(url: string): Promise<string>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  onTerminal(callback: (event: TerminalEvent) => void): () => void;
  windowAction(action: string): Promise<void>;
  // Visited pages, newest first, matching every word of `query`.
  browserHistory(query?: string): Promise<BrowserHistoryEntry[]>;
  removeBrowserHistory(ids: string[]): Promise<void>;
  clearBrowsingData(options: {
    range: BrowserHistoryRange;
    history?: boolean;
    siteData?: boolean;
    cache?: boolean;
  }): Promise<void>;
  // History changed, or tabs' back and forward lists were cleared.
  onBrowserHistoryChanged(callback: () => void): () => void;
  setBrowserDevice(
    guestId: number,
    mode: 'responsive' | 'mobile' | 'tablet' | 'desktop',
  ): Promise<void>;
  // A page in the browser asked to open a link in a new window.
  onBrowserOpenTab(callback: (url: string) => void): () => void;
  // The user's region (ISO 3166 code, or '' when unknown) for searches.
  // A shortcut pressed or menu item chosen inside the page with this id.
  onBrowserCommand(callback: (guestId: number, action: BrowserCommand, value?: string) => void): () => void;
}
export type BrowserHistoryEntry = { id: string; url: string; title: string; visitedAt: number };
// HISTORY_RANGES in electron/browser-history.cjs.
export type BrowserHistoryRange = 'hour' | 'day' | 'week' | 'month' | 'all';
// Commands from electron/browser-guest.cjs, plus a search from its menu.
export type BrowserCommand =
  | 'new-tab'
  | 'close-tab'
  | 'next-tab'
  | 'previous-tab'
  | 'focus-address'
  | 'find'
  | 'reload'
  | 'hard-reload'
  | 'back'
  | 'forward'
  | 'history'
  | 'search';
export type UsageProvider = 'claude' | 'codex';
export type UsageWindow = {
  percent: number;
  resetsAt: number | null;
  /** The recorded window ended; current usage has not yet been confirmed. */
  resetPending?: boolean;
  /** Provider-reported duration for limits outside the standard windows. */
  durationMs?: number;
};
export type PlanUsage = {
  provider: UsageProvider;
  /** ok: live; stale: last known reading; signed-out/expired/error: nothing current to show. */
  status: 'ok' | 'stale' | 'signed-out' | 'expired' | 'error' | 'unsupported';
  /** Opaque hash of the provider, configuration directory and account identity. */
  accountKey?: string;
  plan: string | null;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  source?: 'live' | 'session-log';
  /** When the figures were observed, in milliseconds. */
  updatedAt?: number;
  message?: string;
  /** Set while the provider is rate-limiting checks: when the next one is made. */
  retryAt?: number;
  /** Earliest time a manual check can contact this provider again. */
  refreshAt?: number;
  /** Separate per-model weekly limits some plans have. */
  extras?: { id: string; label: string; window: UsageWindow }[];
};
export type AgentOption = {
  id: string;
  label: string;
  command: string;
  mark: string;
  installed: boolean;
  /** The plugin that contributed this preset; absent for built-in agents. */
  source?: string;
  /** Why a plugin preset cannot launch here. */
  problem?: string;
};
export type AgentSelection = { agentId: string; count: number };

// Plugins -------------------------------------------------------------------
export type PluginKind = 'commands' | 'agents' | 'prompts' | 'skills' | 'mcpServers' | 'themes';
export type PluginThemeColors = Record<
  'chrome' | 'stage' | 'well' | 'raised' | 'accent' | 'foreground' | 'muted' | 'selection' | 'keyword' | 'string',
  string
>;
export type PluginContributes = {
  commands: { id: string; title: string; description: string; run: { program: string; args: string[] } }[];
  agents: { id: string; label: string; program: string; args: string[]; mark: string }[];
  prompts: { id: string; title: string; description: string; body: string }[];
  skills: { id: string; title: string; description: string; body: string }[];
  mcpServers: (
    | { name: string; type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
    | { name: string; type: 'http' | 'sse'; url: string; headers?: Record<string, string>; auth?: McpAuth | null }
  )[];
  themes: { id: string; label: string; base: 'graphite' | 'light'; colors: PluginThemeColors }[];
};
export type PluginSummary = {
  name: string;
  version: string;
  description: string;
  author: { name: string; email?: string; url?: string } | null;
  license: string;
  homepage: string;
  minAppVersion: string;
  compatible: boolean;
  format: 'veyo' | 'claude';
  /** Set when a marketplace lists the plugin under a different name than its manifest. */
  manifestName?: string;
  unsupported: string[];
  counts: Record<PluginKind, number>;
};
export type PluginDetail = PluginSummary & { contributes: PluginContributes; readme?: string };
export type PluginSource =
  | { kind: 'local'; path: string }
  | { kind: 'git'; url: string; ref?: string; path?: string }
  | { kind: 'marketplace'; marketplace: string; name: string };
export type PluginChangeSet = { added: string[]; removed: string[]; changed: string[] };
export type PluginUpdateDiff = {
  fromVersion: string | null;
  toVersion: string;
  commands: PluginChangeSet;
  agents: PluginChangeSet;
  mcpServers: PluginChangeSet;
};
export type PluginPreview = {
  previewId: string;
  id: string;
  marketplace: string;
  source: string;
  sha: string | null;
  plugin: PluginDetail;
  installed: { key: string; scope: 'user' | 'project'; projectId?: string; version: string }[];
  conflict: string | null;
  /** 'runs' when the plugin has commands, agent presets or MCP servers. */
  risk: 'none' | 'runs';
  update: PluginUpdateDiff | null;
};
export type PluginPreviewRequest =
  | { kind: 'local'; path: string }
  | { kind: 'marketplace'; marketplace: string; name: string }
  | { kind: 'git'; url: string; ref?: string };
export type InstalledPlugin = {
  key: string;
  id: string;
  name: string;
  marketplace: string;
  scope: 'user' | 'project';
  projectId?: string;
  version: string;
  sha?: string;
  source: PluginSource;
  installedAt: string;
  lastUpdated: string;
  enabled: boolean;
  active: boolean;
  updateAvailable: boolean;
  /** MCP servers Veyo added to coding CLIs for this install. */
  connections: McpConnection[];
  error?: string;
  plugin?: PluginSummary;
};
export type McpCli = 'claude' | 'codex';
export type McpConnection = { cli: McpCli; name: string; server: string; scope: 'user' | 'project'; at?: string };
export type McpAuth =
  | { type: 'oauth' }
  | { type: 'env'; variable: string; url: string; label: string }
  | { type: 'oauth-client'; callbackPort: number; setupUrl: string; clientIdHint: string };
export type McpPlan = {
  cli: McpCli;
  label: string;
  /** Whether the CLI is on PATH. */
  available: boolean;
  auth: McpAuth['type'] | null;
  /** Why this CLI cannot add the server. */
  unsupported?: string;
  name?: string;
  note?: string;
  commandLine?: string[];
  needsClientId?: boolean;
  followUp?: { kind: 'login'; args: string[] } | { kind: 'env'; variable: string; url: string; label: string } | null;
  /** For token servers: whether the variable is set (never its value). */
  variable?: { name: string; inApp: boolean; saved: boolean };
};
export type PluginMarketplace = {
  name: string;
  source: { kind: 'local'; path: string } | { kind: 'git'; url: string; ref?: string };
  addedAt: string;
  lastUpdated?: string;
  sha?: string;
  /** Veyo's own catalog: added automatically and cannot be removed. */
  builtin?: boolean;
};
export type PluginsState = { plugins: InstalledPlugin[]; marketplaces: PluginMarketplace[] };
export type PluginCatalogEntry = {
  id: string;
  marketplace: string;
  name: string;
  description: string;
  version: string | null;
  category: string;
  tags: string[];
  author: string;
  homepage: string;
  source: string;
  /** 'git' entries need Git to install. */
  sourceType: 'relative' | 'git' | null;
  displayName: string;
  tagline: string;
  /** Who makes the service, such as GitHub or Google. */
  provider: string;
  /** What the person must do before it works: shown as the row's action. */
  setup: 'none' | 'sign-in' | 'token' | 'oauth-client';
  /** data: URLs, or null for a monogram. */
  icon: string | null;
  iconDark: string | null;
  error: string | null;
  installed: { key: string; scope: 'user' | 'project'; projectId?: string; version: string }[];
  updateAvailable: boolean;
};
export type PluginCatalog = {
  marketplaces: (PluginMarketplace & {
    description: string;
    owner: string;
    count: number;
    sections: { id: string; title: string; plugins: string[] }[];
    error?: string;
  })[];
  plugins: PluginCatalogEntry[];
  gitAvailable: boolean;
  /** The built-in catalog's marketplace name, once it has been added. */
  publicName: string | null;
  /** Why the built-in catalog could not be fetched, if it could not. */
  publicError: string;
};
type Provenance = { plugin: string; pluginKey: string };
export type PluginContributions = {
  commands: ({ key: string; title: string; description: string; program: string; args: string[] } & Provenance)[];
  agents: ({ key: string; label: string; mark: string; program: string; args: string[] } & Provenance)[];
  prompts: ({ key: string; kind: 'prompt' | 'skill'; title: string; description: string; body: string } & Provenance)[];
  themes: ({ key: string; label: string; base: PluginContributes['themes'][number]['base']; colors: PluginThemeColors } & Provenance)[];
};
declare global {
  interface Window {
    workspace?: WorkspaceAPI;
  }
}

export type UpdateState = {
  status: 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error';
  /** Installed version. */
  version: string;
  /** Newer version found, when there is one. */
  latest?: string;
  percent?: number;
  error?: string;
  /** False in development and unpacked builds, which cannot update themselves. */
  supported: boolean;
};
