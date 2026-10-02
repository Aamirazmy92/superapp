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
    speakReplies?: boolean;
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
    permission: 'ask' | 'auto' | 'full';
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
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  onTerminal(callback: (event: TerminalEvent) => void): () => void;
  windowAction(action: string): Promise<void>;
  clearBrowserHistory(guestId: number): Promise<void>;
  setBrowserDevice(
    guestId: number,
    mode: 'responsive' | 'mobile' | 'tablet' | 'desktop',
  ): Promise<void>;
}
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
};
export type AgentSelection = { agentId: string; count: number };
declare global {
  interface Window {
    workspace?: WorkspaceAPI;
  }
}
