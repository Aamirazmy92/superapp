import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  MessageSquare,
  SquarePen,
  Search,
  ArrowUp,
  ArrowDown,
  FolderOpen,
  Settings2,
  Square,
  Trash2,
  Download,
  Copy,
  Check,
  Mic,
  Volume2,
  VolumeX,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Paperclip,
  AlertCircle,
  X,
  FileDiff,
  Plus,
  CornerDownLeft,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Info,
  SettingsGear,
  Pin,
  PinOff,
  Pencil,
  CircleDot,
  FolderInput,
  Archive,
  ArchiveRestore,
} from './icons';
import Modal from './Modal';
import MarkdownMessage from './MarkdownMessage';
import AgentLogo from './AgentLogo';
import ChatSelect from './ChatSelect';
import ChatEffort from './ChatEffort';
import ChatAttachments, { readAttachment } from './ChatAttachments';
import ChatActivity from './ChatActivity';
import { ChangesDialog, ChangesSummary, collectChanges, type ChangedFile } from './ChatChanges';
import { AnimatePresence, motion } from 'motion/react';
import { motionReduced } from './motion';
import { AnchoredPopover } from './AnchoredPopover';
import type { ChatMessage, ChatModel, Project, OpenFile, SavedChatState, ChatAttachment, ChatActivity as Activity } from './types';
import './chat.css';

type Provider = 'ollama' | 'codex' | 'claude';
type Permission = 'ask' | 'auto' | 'edits' | 'plan' | 'full';
type Thread = {
  id: string;
  title: string;
  draft: string;
  draftAttachments?: ChatAttachment[];
  projectId: string;
  messages: ChatMessage[];
  provider?: Provider;
  model?: string;
  effort?: string;
  permission?: Permission;
  sessionId?: string;
  error?: string;
  updatedAt?: number;
  pinned?: boolean;
  unread?: boolean;
  archived?: boolean;
  /** A group the user made ("Move to group"); chats without one sit under their project. */
  group?: string;
};
type Approval = { id: string; requestId: string; title: string; detail: string };
const providerNames: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  ollama: 'Ollama',
};
const providerOptions: { value: Provider; label: string; description: string }[] = [
  { value: 'codex', label: 'Codex / ChatGPT', description: 'OpenAI models through the Codex CLI' },
  { value: 'claude', label: 'Claude', description: 'Anthropic models through Claude Code' },
  { value: 'ollama', label: 'Ollama (local)', description: 'Models running on this computer' },
];
const providerLogo = (provider: Provider, size: number) => (
  <AgentLogo
    agentId={provider === 'ollama' ? undefined : provider}
    fallback={<Sparkles size={Math.round(size * 0.85)} />}
    size={size}
  />
);
const cleanError = (value: unknown) =>
  String(value).replace(/^Error: Error invoking remote method '[^']+': Error: /, '');
const modelEffortKey = (provider: string, model: string) => `${provider}:${model}`;
const defaultEndpoint = 'http://localhost:11434';
const providers: Provider[] = ['ollama', 'codex', 'claude'];
const permissions: Permission[] = ['ask', 'auto', 'edits', 'plan', 'full'];
function parseThreads(value: unknown, fallbackModel: string): Thread[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (t) =>
        t && typeof t.id === 'string' && typeof t.draft === 'string' && typeof t.title === 'string',
    )
    .map((t) => ({
      ...t,
      provider: providers.includes(t.provider) ? t.provider : 'ollama',
      model: typeof t.model === 'string' ? t.model : fallbackModel,
      effort: typeof t.effort === 'string' ? t.effort : '',
      permission: permissions.includes(t.permission) ? t.permission : 'ask',
      sessionId: typeof t.sessionId === 'string' ? t.sessionId : undefined,
      projectId: typeof t.projectId === 'string' ? t.projectId : '',
      updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : undefined,
      group: typeof t.group === 'string' && t.group.trim() ? t.group.trim().slice(0, 60) : undefined,
      draftAttachments: Array.isArray(t.draftAttachments) ? t.draftAttachments : [],
      messages: Array.isArray(t.messages)
        ? t.messages.filter(
            (m: ChatMessage) =>
              m && ['user', 'assistant', 'system'].includes(m.role) && typeof m.content === 'string',
          )
        : [],
    }));
}
// Chats used to live in localStorage, which is separate for the dev server and
// the packaged app. Read them once so they can be imported into app storage.
const legacyKeys = [
  'chat-threads',
  'active-chat',
  'chat-endpoint',
  'chat-model',
  'chat-effort',
  'chat-provider',
  'chat-permission',
  'chat-speak-replies',
  'chat-model-efforts',
];
function readLegacyChat(): SavedChatState {
  const read = (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const json = (key: string, fallback: unknown) => {
    try {
      return JSON.parse(read(key) || '') ?? fallback;
    } catch {
      return fallback;
    }
  };
  const efforts = json('chat-model-efforts', {});
  return {
    threads: json('chat-threads', []),
    active: read('active-chat') || null,
    settings: {
      endpoint: read('chat-endpoint') || undefined,
      // A model was only remembered together with its provider.
      model: (read('chat-provider') && read('chat-model')) || undefined,
      effort: read('chat-effort') || undefined,
      provider: read('chat-provider') || undefined,
      permission: read('chat-permission') || undefined,
      speakReplies: read('chat-speak-replies') === 'true',
      modelEfforts: efforts && typeof efforts === 'object' && !Array.isArray(efforts) ? efforts : {},
    },
  };
}
const effortNames: Record<string, string> = { xhigh: 'Extra high' };
const effortLabel = (level: string) =>
  effortNames[level] || (level ? level.charAt(0).toUpperCase() + level.slice(1) : 'Default');
const titleFrom = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || 'New chat';
};
// Chats without a project, or whose project was removed, are listed here.
const GENERAL_GROUP = 'General';
const COLLAPSED_GROUPS_KEY = 'chat-collapsed-groups';
const PINNED_GROUP = '__pinned';
const ARCHIVED_GROUP = '__archived';
const customGroupKey = (name: string) => `group:${name}`;
const starters = [
  { title: 'Explain code', detail: 'Walk through what a snippet does', prompt: 'Explain what this code does, step by step:\n\n' },
  { title: 'Debug an error', detail: 'Find the cause and a fix', prompt: 'Help me debug this error. Here is the message and the relevant code:\n\n' },
  { title: 'Write tests', detail: 'Cover edge cases for a function', prompt: 'Write unit tests, including edge cases, for this function:\n\n' },
  { title: 'Review an approach', detail: 'Get trade-offs before you build', prompt: 'Review this approach and point out risks or simpler alternatives:\n\n' },
];

export default function ChatWorkspace({
  projects,
  activeFile,
  activeProject,
  handoff,
  chatDefaults = { provider: 'last', permission: 'last' },
  onOpenFile,
}: {
  projects: Project[];
  activeFile?: OpenFile;
  activeProject: string | null;
  handoff?: { id: string; projectId: string; draft: string; attachActiveFile: boolean } | null;
  /** From Settings: 'last' keeps what the previous chat used. */
  chatDefaults?: { provider: Provider | 'last'; permission: Permission | 'last' };
  onOpenFile?(projectId: string, path: string): void;
}) {
  const api = window.workspace!;
  const [threads, setThreads] = useState<Thread[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const importingLegacy = useRef(false);
  const [query, setQuery] = useState('');
  const [endpoint, setEndpoint] = useState(defaultEndpoint);
  const [provider, setProvider] = useState<Provider>('codex');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [modelEfforts, setModelEfforts] = useState<Record<string, string>>({});
  const [models, setModels] = useState<ChatModel[]>([]);
  const [modelRefresh, setModelRefresh] = useState(0);
  const modelRequest = useRef(0);
  const [permission, setPermission] = useState<Permission>('ask');
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const approval = approvals[0];
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(false);
  const [settings, setSettings] = useState(false);
  const [checking, setChecking] = useState(false);
  const [connection, setConnection] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [pending, setPending] = useState<{ threadId: string; requestId: string } | null>(null);
  const streamRef = useRef<{ requestId: string; threadId: string; text: string; activities: Activity[] } | null>(null);
  const streamFrame = useRef<number | null>(null);
  const [streamText, setStreamText] = useState('');
  const [streamActivities, setStreamActivities] = useState<Activity[]>([]);
  const [uploading, setUploading] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);
  const sending = useRef(false);
  // The message just sent rises in as it appears, matching the reply bubble
  // below it. Only its first mount animates, so switching threads never replays it.
  const sentMessage = useRef<string | null>(null);
  const riseInIfSent = (key: string) => (node: HTMLElement | null) => {
    if (!node || sentMessage.current !== key) return;
    sentMessage.current = null;
    if (motionReduced()) return;
    node.animate(
      { opacity: [0, 1], transform: ['translateY(4px)', 'none'] },
      { duration: 140, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
  };
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [trustPrompt, setTrustPrompt] = useState<{
    files: string[];
    resolve(decision: 'trusted' | 'ignored' | null): void;
  } | null>(null);
  const [includeFile, setIncludeFile] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const followOutput = useRef(true);
  const conversation = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const thread = threads.find((t) => t.id === active);
  const chosenProvider = thread?.provider || provider;
  const chosenModel = thread?.model ?? model;
  const chosenEffort = thread?.effort ?? effort;
  const selectedModel = models.find((item) => item.id === chosenModel);
  const supportedEfforts = selectedModel?.efforts || [];
  const effectiveEffort = supportedEfforts.includes(chosenEffort) ? chosenEffort : '';
  const defaultEffort = supportedEfforts.includes(selectedModel?.defaultEffort || '')
    ? selectedModel!.defaultEffort!
    : '';
  const reasoningLevels = defaultEffort ? supportedEfforts : ['', ...supportedEfforts];
  const shownEffort = effectiveEffort || defaultEffort;
  const storedPermission = thread?.permission || permission;
  // Accept edits and Plan are Claude Code modes; other providers fall back to asking.
  const chosenPermission: Permission =
    chosenProvider !== 'claude' && (storedPermission === 'edits' || storedPermission === 'plan')
      ? 'ask'
      : storedPermission;
  const chosenProjectId = thread?.projectId ?? activeProject ?? '';
  const chosenProject = projects.find((p) => p.id === chosenProjectId);
  const pendingHere = !!pending && pending.threadId === thread?.id;
  const busyElsewhere = !!pending && !pendingHere;
  const attachable = chosenProjectId === activeProject ? activeFile : undefined;
  const visibleMessages = useMemo(() => thread?.messages.filter((m) => m.role !== 'system') || [], [thread?.messages]);
  const projectRoot = projects.find((p) => p.id === thread?.projectId)?.root;
  const threadChanges = useMemo(
    () => collectChanges([...visibleMessages.flatMap((message) => message.activities || []), ...(pendingHere ? streamActivities : [])]),
    [visibleMessages, pendingHere, streamActivities],
  );
  const [changesView, setChangesView] = useState<{ title: string; files: ChangedFile[] } | null>(null);
  const openChangedFile = onOpenFile && thread?.projectId
    ? (path: string) => {
        setChangesView(null);
        onOpenFile(thread.projectId!, path);
      }
    : undefined;
  const draftAttachments = thread?.draftAttachments || [];
  const logo = (size: number) => providerLogo(chosenProvider, size);
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = threads
      .filter(
        (t) =>
          !needle ||
          `${t.title} ${t.messages.map((m) => m.content).join(' ')}`
            .toLowerCase()
            .includes(needle),
      )
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    // Pinned first, then General and each project in sidebar order, newest chats first;
    // archived chats wait in their own section at the bottom.
    const projectOf = (t: Thread) => projects.find((p) => p.id === t.projectId);
    const live = matches.filter((t) => !t.archived);
    const pinned = live.filter((t) => t.pinned);
    const unpinned = live.filter((t) => !t.pinned);
    const named = [...new Set(unpinned.map((t) => t.group).filter((g): g is string => !!g))].sort((a, b) =>
      a.localeCompare(b),
    );
    const rest = unpinned.filter((t) => !t.group);
    return [
      { key: PINNED_GROUP, label: 'Pinned', items: pinned },
      ...named.map((name) => ({
        key: customGroupKey(name),
        label: name,
        items: unpinned.filter((t) => t.group === name),
      })),
      { key: '', label: GENERAL_GROUP, items: rest.filter((t) => !projectOf(t)) },
      ...projects.map((p) => ({
        key: p.id,
        label: p.name,
        items: rest.filter((t) => t.projectId === p.id),
      })),
      { key: ARCHIVED_GROUP, label: 'Archived', items: matches.filter((t) => t.archived) },
    ].filter((group) => group.items.length);
  }, [threads, query, projects]);
  // Minimised groups, by project id ('' for General), kept between sessions.
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) || '{}');
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(collapsedGroups));
    } catch {
      // Not remembering which groups are minimised is harmless.
    }
  }, [collapsedGroups]);
  const groupKeyOf = (t: Thread) => (projects.some((p) => p.id === t.projectId) ? t.projectId : '');
  const setGroupCollapsed = (key: string, collapsed: boolean) =>
    setCollapsedGroups((current) => {
      if (!!current[key] === collapsed) return current;
      const next = { ...current };
      if (collapsed) next[key] = true;
      else delete next[key];
      return next;
    });
  // Opening or starting a chat shows the group it is in.
  const activeGroupKey = thread ? groupKeyOf(thread) : null;
  useEffect(() => {
    if (activeGroupKey !== null) setGroupCollapsed(activeGroupKey, false);
  }, [active, activeGroupKey]);
  // Search results are never hidden in a minimised group.
  const searching = !!query.trim();
  const collapsed = (key: string) =>
    !searching && (key === ARCHIVED_GROUP ? !showArchived : !!collapsedGroups[key]);
  const toggleGroup = (key: string) =>
    key === ARCHIVED_GROUP ? setShowArchived((open) => !open) : setGroupCollapsed(key, !collapsedGroups[key]);
  const focusComposer = () => requestAnimationFrame(() => composer.current?.focus());
  useEffect(() => {
    if (!handoff) return;
    const next: Thread = {
      id: handoff.id,
      title: 'New chat',
      draft: handoff.draft,
      projectId: handoff.projectId,
      messages: [],
      updatedAt: Date.now(),
    };
    setThreads((previous) =>
      previous.some((item) => item.id === next.id) ? previous : [next, ...previous],
    );
    setActive(next.id);
    setIncludeFile(handoff.attachActiveFile);
    focusComposer();
  }, [handoff?.id]);
  useEffect(() => {
    let canceled = false;
    api
      .getChatState()
      .catch(() => null)
      .then((saved) => {
        if (canceled) return;
        importingLegacy.current = !saved;
        const data = saved || readLegacyChat();
        const s = data.settings;
        const loadedThreads = parseThreads(data.threads, s.model || '');
        // A handoff may have created a thread while this was loading; keep it.
        setThreads((current) => [
          ...current.filter((t) => !loadedThreads.some((item) => item.id === t.id)),
          ...loadedThreads,
        ]);
        setActive((current) => current ?? data.active);
        setEndpoint(s.endpoint || defaultEndpoint);
        const savedProvider = providers.includes(s.provider as Provider)
          ? (s.provider as Provider)
          : 'codex';
        const startProvider =
          chatDefaults.provider === 'last' ? savedProvider : chatDefaults.provider;
        // A remembered model belongs to the remembered provider.
        const keepModel = startProvider === savedProvider;
        setProvider(startProvider);
        setModel(keepModel ? s.model || '' : '');
        setEffort(keepModel ? s.effort || '' : '');
        setPermission(
          chatDefaults.permission !== 'last'
            ? chatDefaults.permission
            : permissions.includes(s.permission as Permission)
              ? (s.permission as Permission)
              : 'ask',
        );
        setSpeakReplies(s.speakReplies === true);
        setModelEfforts(s.modelEfforts || {});
        setLoaded(true);
      });
    return () => {
      canceled = true;
    };
  }, []);
  const chatState = useMemo<SavedChatState>(
    () => ({
      threads,
      active,
      settings: { endpoint, model, effort, provider, permission, speakReplies, modelEfforts },
    }),
    [threads, active, endpoint, model, effort, provider, permission, speakReplies, modelEfforts],
  );
  const unsaved = useRef<SavedChatState | null>(null);
  const saveChat = useCallback(async () => {
    const value = unsaved.current;
    if (!value) return;
    unsaved.current = null;
    try {
      await api.saveChatState(value);
      setStorageError((current) => current.startsWith('Chats could not be saved:') ? '' : current);
      if (importingLegacy.current) {
        importingLegacy.current = false;
        try {
          for (const key of legacyKeys) localStorage.removeItem(key);
        } catch {}
      }
    } catch (error) {
      unsaved.current ||= value;
      setStorageError(
        `Chats could not be saved: ${cleanError(error)} Export important conversations, then delete older chats.`,
      );
    }
  }, []);
  useEffect(() => {
    if (!loaded) return;
    // Drafts change on every keystroke, so batch writes of the full history.
    unsaved.current = chatState;
    const timer = window.setTimeout(saveChat, 400);
    return () => window.clearTimeout(timer);
  }, [loaded, chatState]);
  useEffect(() => {
    const flush = () => void saveChat();
    const stop = api.onBeforeClose(flush);
    return () => {
      stop();
      flush();
    };
  }, []);
  useEffect(() => {
    const refresh = () => setModelRefresh((value) => value + 1);
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 15 * 60 * 1000);
    return () => {
      window.removeEventListener('focus', refresh);
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    // Until saved chats load, the default provider and empty model would pick
    // a model that then overwrites the saved one.
    if (!loaded) return;
    let current = true;
    const version = ++modelRequest.current;
    setChecking(true);
    api
      .chatModels(chosenProvider, endpoint)
      .then((items) => {
        if (!current || version !== modelRequest.current) return;
        setModels(items);
        setConnectionError('');
        if (!chosenModel && items.length) {
          const first = items.find((item) => item.isDefault) || items[0];
          const savedEffort = modelEfforts[modelEffortKey(chosenProvider, first.id)] || '';
          if (thread)
            setThreads((previous) =>
              previous.map((t) =>
                t.id === thread.id ? { ...t, model: first.id, effort: savedEffort } : t,
              ),
            );
          else {
            setModel(first.id);
            setEffort(savedEffort);
          }
        }
      })
      .catch((error) => {
        if (current && version === modelRequest.current) {
          setModels([]);
          setConnectionError(cleanError(error));
        }
      })
      .finally(() => {
        if (current && version === modelRequest.current) setChecking(false);
      });
    return () => {
      current = false;
    };
  }, [loaded, chosenProvider, endpoint, active, modelRefresh]);
  useEffect(() => {
    followOutput.current = true;
    setAtBottom(true);
    end.current?.scrollIntoView({ block: 'end' });
  }, [active]);
  useEffect(() => {
    if (followOutput.current) end.current?.scrollIntoView({ block: 'end' });
  }, [thread?.messages.length, thread?.error, pending, streamText]);
  useLayoutEffect(() => {
    const box = composer.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 240)}px`;
  }, [thread?.draft, active]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const reportMarkdownError = useCallback(
    (error: unknown) => setStorageError(cleanError(error)),
    [],
  );
  useEffect(() => {
    const unsubscribe = api.onChatChunk(({ id, text }) => {
        const current = streamRef.current;
        if (!current || current.requestId !== id) return;
        current.text += text;
        if (streamFrame.current !== null) return;
        streamFrame.current = window.setTimeout(() => {
          streamFrame.current = null;
          if (streamRef.current === current) {
            setStreamText(current.text);
            setStreamActivities([...current.activities]);
          }
        }, 50);
      });
    return () => {
      unsubscribe();
      if (streamFrame.current !== null) window.clearTimeout(streamFrame.current);
    };
  }, []);
  useEffect(() => api.onChatActivity(({ id, activity }) => {
    const current = streamRef.current;
    if (!current || current.requestId !== id) return;
    const index = current.activities.findIndex((item) => item.id === activity.id);
    if (index >= 0) current.activities[index] = activity;
    else {
      if (current.activities.length >= 100) current.activities.shift();
      current.activities.push(activity);
    }
    if (streamFrame.current !== null) return;
    streamFrame.current = window.setTimeout(() => {
      streamFrame.current = null;
      if (streamRef.current === current) {
        setStreamText(current.text);
        setStreamActivities([...current.activities]);
      }
    }, 50);
  }), []);
  useEffect(() => api.onChatSession(({ id, sessionId }) => {
    const current = streamRef.current;
    if (!current || current.requestId !== id) return;
    setThreads((previous) => previous.map((t) => t.id === current.threadId ? { ...t, sessionId } : t));
  }), []);
  useEffect(() => api.onChatApproval((value) => setApprovals((queue) => [...queue, value])), []);
  // New chats started explicitly use the Settings defaults; a chat created by typing
  // into the empty composer keeps whatever was just chosen there.
  function create(useDefaults = false, projectId = activeProject || '') {
    const nextProvider =
      useDefaults && chatDefaults.provider !== 'last' ? chatDefaults.provider : provider;
    const keepModel = nextProvider === provider;
    const nextPermission =
      useDefaults && chatDefaults.permission !== 'last' ? chatDefaults.permission : permission;
    if (!keepModel) {
      setProvider(nextProvider);
      setModel('');
      setEffort('');
      setModels([]);
    }
    setPermission(nextPermission);
    const next: Thread = {
      id: crypto.randomUUID(),
      title: 'New chat',
      draft: '',
      projectId,
      messages: [],
      provider: nextProvider,
      model: keepModel ? model : '',
      effort: keepModel ? effort : '',
      permission: nextPermission,
      updatedAt: Date.now(),
    };
    setThreads((previous) => [next, ...previous]);
    setActive(next.id);
    return next;
  }
  // A chat in the given project ('' for none); the current chat is reused
  // while it is still empty.
  function startNewChat(projectId = activeProject || '') {
    if (!thread || thread.messages.length || thread.draft.trim() || thread.draftAttachments?.length || thread.error) {
      create(true, projectId);
      setIncludeFile(false);
    } else if (thread.projectId !== projectId) {
      changeProject(projectId);
    }
    focusComposer();
  }
  function openThread(t: Thread) {
    if (t.unread) patchThread(t.id, { unread: false });
    setActive(t.id);
    setProvider(t.provider || 'ollama');
    setModel(t.model || '');
    setEffort(t.effort || '');
    setPermission(t.permission || 'ask');
    setIncludeFile(false);
    focusComposer();
  }
  function edit(patch: Partial<Thread>) {
    const target = thread || create();
    setThreads((previous) => previous.map((t) => (t.id === target.id ? { ...t, ...patch } : t)));
  }
  // Right-click / "..." menu on a chat in the sidebar.
  const [threadMenu, setThreadMenu] = useState<{ id: string; anchor: HTMLElement; view: 'main' | 'groups' } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [groupPrompt, setGroupPrompt] = useState<{ id: string; value: string } | null>(null);
  const groupNames = useMemo(
    () => [...new Set(threads.map((t) => t.group).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b)),
    [threads],
  );
  const patchThread = (id: string, patch: Partial<Thread>) =>
    setThreads((previous) => previous.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const menuThread = threadMenu ? threads.find((t) => t.id === threadMenu.id) : undefined;
  useEffect(() => {
    if (!threadMenu) return;
    const close = () => setThreadMenu(null);
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.workspace-context-menu, .chat-thread-more')) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [threadMenu]);
  function openThreadMenu(id: string, anchor: HTMLElement) {
    setThreadMenu((current) => (current?.id === id ? null : { id, anchor, view: 'main' }));
  }
  function moveThread(id: string, group: string | undefined) {
    patchThread(id, { group });
    setThreadMenu(null);
  }
  function saveGroupPrompt() {
    if (!groupPrompt) return;
    const name = groupPrompt.value.trim().slice(0, 60);
    if (!name) return;
    // Reuse the existing spelling when the name matches a group that is already there.
    const existing = groupNames.find((g) => g.toLowerCase() === name.toLowerCase());
    patchThread(groupPrompt.id, { group: existing || name });
    setGroupPrompt(null);
  }
  function commitRename() {
    if (!renaming) return;
    const title = renaming.value.trim();
    if (!title) return;
    patchThread(renaming.id, { title });
    setRenaming(null);
  }
  async function attachFiles(files: File[]) {
    if (!files.length || uploadingRef.current || sending.current) return;
    const target = thread || create();
    if ((target.draftAttachments?.length || 0) + files.length > 8) {
      setStorageError('Attach up to 8 files per message.');
      return;
    }
    if (files.reduce((sum, file) => sum + file.size, 0) + (target.draftAttachments || []).reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) {
      setStorageError('Attachments must total less than 20 MB.');
      return;
    }
    uploadingRef.current = true;
    setUploading(true);
    try {
      const inputs = await Promise.all(files.map(readAttachment));
      const added = await api.chatStoreAttachments(inputs);
      setThreads((previous) => previous.map((t) => t.id === target.id
        ? { ...t, draftAttachments: [...(t.draftAttachments || []), ...added] } : t));
      setStorageError('');
    } catch (error) { setStorageError(cleanError(error)); }
    finally { uploadingRef.current = false; setUploading(false); }
  }
  function copy(text: string, key: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(key))
      .catch(() => setStorageError('Unable to copy. Select the message text to copy it manually.'));
  }
  function selectModel(nextModel: string) {
    const nextEffort = modelEfforts[modelEffortKey(chosenProvider, nextModel)] || '';
    edit({ model: nextModel, effort: nextEffort });
    setModel(nextModel);
    setEffort(nextEffort);
  }
  function selectEffort(nextEffort: string) {
    edit({ effort: nextEffort });
    setEffort(nextEffort);
    const key = modelEffortKey(chosenProvider, chosenModel);
    setModelEfforts((previous) => {
      const next = { ...previous };
      if (nextEffort) next[key] = nextEffort;
      else delete next[key];
      return next;
    });
  }
  async function connect() {
    const version = ++modelRequest.current;
    setChecking(true);
    setConnection('');
    setConnectionError('');
    try {
      const names = await api.chatModels(chosenProvider, endpoint, true);
      if (version !== modelRequest.current) return;
      setModels(names);
      if (
        !chosenModel ||
        (!thread?.messages.length && !names.some((item) => item.id === chosenModel))
      ) {
        const first = names.find((item) => item.isDefault) || names[0];
        const savedEffort = modelEfforts[modelEffortKey(chosenProvider, first?.id || '')] || '';
        if (thread) edit({ model: first?.id || '', effort: savedEffort });
        else {
          setModel(first?.id || '');
          setEffort(savedEffort);
        }
      }
      setConnection(
        names.length
          ? `Connected · ${names.length} available models`
          : chosenProvider === 'ollama'
            ? 'Connected, but no models are installed. Pull a model with Ollama, then refresh.'
            : 'Connected, but this account has no available models.',
      );
    } catch (error) {
      if (version === modelRequest.current) setConnectionError(`Unable to connect. ${cleanError(error)}`);
    } finally {
      if (version === modelRequest.current) setChecking(false);
    }
  }
  /** Resend from an earlier user message: everything after it is dropped, `content` replaces its text. */
  type Rewrite = { index: number; content: string; attachments?: ChatAttachment[] };
  async function send(retry = false, voicePrompt?: string, rewrite?: Rewrite) {
    if (sending.current || uploadingRef.current || (!retry && !rewrite && !(voicePrompt || thread?.draft || '').trim() && !draftAttachments.length)) return;
    const target = thread || create();
    if (!chosenModel.trim()) {
      if (voicePrompt)
        setThreads((previous) =>
          previous.map((t) => (t.id === target.id ? { ...t, draft: voicePrompt } : t)),
        );
      setSettings(true);
      return;
    }
    // A project's own Claude settings can run hooks and pre-approve tools, so
    // the first Claude chat in a project that has them asks whether to trust
    // it. Until it is trusted, chat uses only the person's own settings.
    if (chosenProvider === 'claude' && target.projectId) {
      sending.current = true;
      try {
        const status = await api.claudeSettings(target.projectId).catch(() => null);
        if (status && !status.decision && status.files.length) {
          const decision = await new Promise<'trusted' | 'ignored' | null>((resolve) =>
            setTrustPrompt({ files: status.files, resolve }),
          );
          setTrustPrompt(null);
          if (!decision) return;
          await api.setClaudeSettings(target.projectId, decision);
        }
      } catch (error) {
        setStorageError(cleanError(error));
        return;
      } finally {
        sending.current = false;
      }
    }
    const attached = !retry && !rewrite && includeFile && target.projectId === activeProject ? activeFile : undefined;
    let messageAttachments = rewrite ? rewrite.attachments || [] : target.draftAttachments || [];
    if (attached) {
      sending.current = true;
      setUploading(true);
      try {
        if (messageAttachments.length >= 8) throw new Error('Attach up to 8 files per message, including the open editor file.');
        const stored = await api.chatStoreAttachments([await readAttachment(new File([attached.content], attached.path, { type: 'text/plain' }))]);
        messageAttachments = [...messageAttachments, ...stored];
      } catch (error) {
        setStorageError(cleanError(error));
        sending.current = false;
        return;
      } finally { setUploading(false); }
    }
    const messages: ChatMessage[] = rewrite
      ? [
          ...target.messages.slice(0, rewrite.index),
          { role: 'user', content: rewrite.content.trim() || 'Please review the attached files.', attachments: messageAttachments },
        ]
      : retry
      ? target.error && target.messages.at(-1)?.role === 'assistant'
        ? target.messages.slice(0, -1)
        : [...target.messages]
      : [...target.messages, { role: 'user', content: (voicePrompt || target.draft).trim() || 'Please review the attached files.', attachments: messageAttachments }];
    const requestMessages = [...messages];
    const requestId = crypto.randomUUID(),
      threadId = target.id;
    // The provider's saved session still holds the replaced turns, so it starts over from the
    // visible history.
    const sessionId = rewrite ? undefined : target.sessionId;
    if (!retry)
      sentMessage.current = `${threadId}:${messages.filter((m) => m.role !== 'system').length - 1}`;
    sending.current = true;
    followOutput.current = true;
    setAtBottom(true);
    streamRef.current = { requestId, threadId, text: '', activities: [] };
    setStreamText('');
    setStreamActivities([]);
    setPending({ threadId, requestId });
    setThreads((previous) =>
      previous.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages,
              draft: retry || rewrite ? t.draft : '',
              draftAttachments: retry || rewrite ? t.draftAttachments : [],
              sessionId: rewrite ? undefined : t.sessionId,
              error: undefined,
              updatedAt: Date.now(),
              title:
                t.title === 'New chat'
                  ? titleFrom(messages.find((m) => m.role === 'user')?.content || '')
                  : t.title,
            }
          : t,
      ),
    );
    let failedText = '';
    let failedActivities: Activity[] = [];
    try {
      const response = await api.chatSend({
        id: requestId,
        provider: chosenProvider,
        permission: chosenPermission,
        projectId: target.projectId,
        prompt: requestMessages.at(-1)?.content || '',
        sessionId,
        attachments: messages.at(-1)?.attachments,
        endpoint,
        model: chosenModel,
        effort: effectiveEffort || undefined,
        messages: requestMessages,
      });
      if (response.error) {
        failedText = response.text;
        failedActivities = response.activities || [];
        if (response.sessionId) setThreads((previous) => previous.map((t) => t.id === threadId ? { ...t, sessionId: response.sessionId! } : t));
        throw new Error(response.error);
      }
      const completedActivities = response.activities || [...(streamRef.current?.activities || [])];
      setThreads((previous) =>
        previous.map((t) =>
          t.id === threadId
            ? {
                ...t,
                messages: [...messages, { role: 'assistant', content: response.text, activities: completedActivities }],
                sessionId: response.sessionId || t.sessionId,
                provider: chosenProvider,
                model: chosenModel,
                effort: effectiveEffort,
                permission: chosenPermission,
                error: undefined,
                updatedAt: Date.now(),
              }
            : t,
        ),
      );
      if (speakReplies || voicePrompt) {
        setSpeaking(true);
        api
          .voiceSpeak(response.text)
          .catch((error) => setStorageError(cleanError(error)))
          .finally(() => setSpeaking(false));
      }
    } catch (error) {
      const partial = failedText || (streamRef.current?.requestId === requestId ? streamRef.current.text : '');
      const activities = (failedActivities.length ? failedActivities : streamRef.current?.requestId === requestId ? streamRef.current.activities : []).map((item) => item.status === 'running' ? { ...item, status: 'failed' as const } : item);
      setThreads((previous) =>
        previous.map((t) =>
          t.id === threadId
            ? {
                ...t,
                messages: partial || activities.length
                  ? [...messages, { role: 'assistant', content: partial, activities }]
                  : messages,
                error: cleanError(error),
              }
            : t,
        ),
      );
    } finally {
      sending.current = false;
      streamRef.current = null;
      if (streamFrame.current !== null) {
        window.clearTimeout(streamFrame.current);
        streamFrame.current = null;
      }
      setStreamText('');
      setStreamActivities([]);
      setPending(null);
      setApprovals((queue) => queue.filter((item) => item.requestId !== requestId));
    }
  }
  // Editing a sent message: Save replaces it, drops everything after it and asks again.
  const [editing, setEditing] = useState<{ index: number; value: string } | null>(null);
  useEffect(() => setEditing(null), [active]);
  function resendFrom(index: number, content: string, attachments?: ChatAttachment[]) {
    setEditing(null);
    void send(false, undefined, { index, content, attachments });
  }
  const isStopped = (error?: string) => !!error && /^Response stopped/i.test(error);
  function editLastPrompt() {
    if (!thread) return;
    const index = thread.messages.map((m) => m.role).lastIndexOf('user');
    if (index >= 0) setEditing({ index, value: thread.messages[index].content });
  }
  function answerApproval(allowed: boolean) {
    const current = approvals[0];
    if (!current) return;
    setApprovals((queue) => queue.filter((item) => item.id !== current.id));
    api.chatApproval(current.id, allowed).catch((error) => {
      if (allowed) setStorageError(cleanError(error));
    });
  }
  function changeProvider(next: Provider) {
    if (next === chosenProvider) return;
    setProvider(next);
    setModel('');
    setEffort('');
    setModels([]);
    setConnection('');
    setConnectionError('');
    if (thread?.messages.length) {
      const nextThread: Thread = {
        id: crypto.randomUUID(),
        title: 'New chat',
        draft: '',
        projectId: thread.projectId,
        messages: [],
        provider: next,
        model: '',
        effort: '',
        permission,
        updatedAt: Date.now(),
      };
      setThreads((previous) => [nextThread, ...previous]);
      setActive(nextThread.id);
    } else if (thread) edit({ provider: next, model: '', effort: '', sessionId: undefined });
  }
  function changeProject(projectId: string) {
    if (thread?.messages.length) {
      const nextThread: Thread = {
        id: crypto.randomUUID(),
        title: 'New chat',
        draft: '',
        projectId,
        messages: [],
        provider: chosenProvider,
        model: chosenModel,
        effort: effectiveEffort,
        permission: chosenPermission,
        updatedAt: Date.now(),
      };
      setThreads((previous) => [nextThread, ...previous]);
      setActive(nextThread.id);
    } else edit({ projectId, sessionId: undefined });
    setIncludeFile(false);
  }
  async function startVoice() {
    if (listening || speaking) {
      await api.voiceStop();
      setListening(false);
      setSpeaking(false);
      return;
    }
    setListening(true);
    try {
      const transcript = await api.voiceListen();
      await send(false, transcript);
    } catch (error) {
      const message = cleanError(error);
      if (!/speech service failed/i.test(message)) setStorageError(message);
    } finally {
      setListening(false);
    }
  }
  function exportChat() {
    if (!thread) return;
    const blob = new Blob(
      [
        `# ${thread.title}\n\n${visibleMessages.map((m) => `## ${m.role === 'user' ? 'You' : 'Assistant'}\n\n${m.content}`).join('\n\n')}`,
      ],
      { type: 'text/markdown' },
    );
    const url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = `${thread.title.replace(/[^a-z0-9 -]/gi, '').trim().slice(0, 60) || 'chat'}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function scrollToEnd() {
    followOutput.current = true;
    setAtBottom(true);
    end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }
  return (
    <div className="chat-layout"
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        void attachFiles(Array.from(event.dataTransfer.files));
      }}>
      <aside className="projects-sidebar chat-sidebar">
        <div className="chat-sidebar-top">
          <button className="chat-new-button" aria-label="New chat" onClick={() => startNewChat()}>
            <SquarePen size={15} aria-hidden="true" />
            <span>New chat</span>
          </button>
          <label className="chat-search">
            <Search size={14} aria-hidden="true" />
            <input
              aria-label="Search chats"
              placeholder="Search chats"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setQuery('');
              }}
            />
            {query && (
              <button
                type="button"
                className="chat-search-clear"
                aria-label="Clear search"
                onClick={() => setQuery('')}
              >
                <X size={12} />
              </button>
            )}
          </label>
        </div>
        <nav className="chat-thread-list" aria-label="Conversations">
          {groups.length > 1 && !searching && (
            <div className="chat-thread-list-head">
              <span>Chats</span>
            </div>
          )}
          {groups.map((group) => (
            <section key={group.key} className="chat-thread-group" aria-label={group.label}>
              <div className="chat-group-header">
                <h3>
                  <button
                    className={`chat-group-toggle ${collapsed(group.key) ? 'collapsed' : ''}`}
                    aria-expanded={!collapsed(group.key)}
                    title={`${collapsed(group.key) ? 'Expand' : 'Minimise'} ${group.label}`}
                    onClick={() => toggleGroup(group.key)}
                  >
                    <span className="chat-group-name">{group.label}</span>
                    <ChevronDown size={12} aria-hidden="true" />
                    {collapsed(group.key) && group.items.some((t) => pending?.threadId === t.id) && (
                      <span className="chat-thread-live" role="status" aria-label="Responding" />
                    )}
                  </button>
                </h3>
                {!group.key.startsWith('__') && !group.key.startsWith('group:') && (
                  <button
                    className="chat-group-new"
                    aria-label={`Start chat in ${group.label}`}
                    title={`Start chat in ${group.label}`}
                    onClick={() => startNewChat(group.key)}
                  >
                    <Plus size={13} />
                  </button>
                )}
              </div>
              {!collapsed(group.key) && group.items.map((t) => {
                const responding = pending?.threadId === t.id;
                const name = t.title === 'New chat' ? 'Untitled chat' : t.title;
                return (
                  <div
                    key={t.id}
                    className={`chat-thread ${active === t.id ? 'active' : ''} ${responding ? 'responding' : ''} ${t.unread ? 'unread' : ''}`}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setThreadMenu({ id: t.id, anchor: event.currentTarget, view: 'main' });
                    }}
                  >
                    <button
                      className="chat-thread-open"
                      aria-current={active === t.id ? 'true' : undefined}
                      title={name}
                      onClick={() => openThread(t)}
                    >
                      <span>{name}</span>
                    </button>
                    {responding ? (
                      <span className="chat-thread-live" role="status" aria-label="Responding" />
                    ) : (
                      <>
                        {t.unread && <span className="chat-thread-unread" role="status" aria-label="Unread" />}
                        <button
                          className="chat-thread-delete chat-thread-more"
                          aria-label={`Options for ${name}`}
                          aria-haspopup="menu"
                          aria-expanded={threadMenu?.id === t.id}
                          title="Chat options"
                          onClick={(event) => openThreadMenu(t.id, event.currentTarget.closest('.chat-thread') as HTMLElement)}
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
          {!threads.length && (
            <p className="chat-thread-empty">Your conversations will appear here.</p>
          )}
          {!!threads.length && !groups.length && (
            <p className="chat-thread-empty">No chats match “{query.trim()}”.</p>
          )}
        </nav>
        <div className="chat-sidebar-footer">
          <button className="sidebar-settings" onClick={() => setSettings(true)}>
            <SettingsGear size={15} aria-hidden="true" />
            Settings
          </button>
        </div>
        <AnimatePresence>
          {threadMenu && menuThread && (
            <AnchoredPopover anchor={threadMenu.anchor} className="context-menu workspace-context-menu" role="menu">
              <button role="menuitem" onClick={() => { patchThread(menuThread.id, { pinned: !menuThread.pinned }); setThreadMenu(null); }}>
                {menuThread.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                <span>{menuThread.pinned ? 'Unpin' : 'Pin'}</span>
              </button>
              <button role="menuitem" onClick={() => { patchThread(menuThread.id, { unread: !menuThread.unread }); setThreadMenu(null); }}>
                <CircleDot size={14} />
                <span>{menuThread.unread ? 'Mark as read' : 'Mark as unread'}</span>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setRenaming({ id: menuThread.id, value: menuThread.title === 'New chat' ? '' : menuThread.title });
                  setThreadMenu(null);
                }}
              >
                <Pencil size={14} />
                <span>Rename</span>
              </button>
              <div className="menu-separator" role="separator" />
              <div
                className="menu-submenu-wrap"
                onMouseEnter={() => setThreadMenu((m) => (m ? { ...m, view: 'groups' } : m))}
                onMouseLeave={() => setThreadMenu((m) => (m ? { ...m, view: 'main' } : m))}
              >
                <button
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={threadMenu.view === 'groups'}
                  onClick={() => setThreadMenu((m) => (m ? { ...m, view: 'groups' } : m))}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowRight') setThreadMenu((m) => (m ? { ...m, view: 'groups' } : m));
                  }}
                >
                  <FolderInput size={14} />
                  <span>Move to group</span>
                  <ChevronRight size={14} className="menu-chevron" />
                </button>
                {threadMenu.view === 'groups' && (
                  <div className="menu-submenu" role="menu" aria-label="Move to group">
                    {groupNames.map((name) => (
                      <button
                        key={name}
                        role="menuitemradio"
                        aria-checked={menuThread.group === name}
                        onClick={() => moveThread(menuThread.id, menuThread.group === name ? undefined : name)}
                      >
                        <FolderInput size={14} />
                        <span>{name}</span>
                        {menuThread.group === name && <Check size={14} className="menu-check" />}
                      </button>
                    ))}
                    {menuThread.group && (
                      <button role="menuitem" onClick={() => moveThread(menuThread.id, undefined)}>
                        <X size={14} />
                        <span>Remove from group</span>
                      </button>
                    )}
                    <button
                      role="menuitem"
                      onClick={() => {
                        setGroupPrompt({ id: menuThread.id, value: '' });
                        setThreadMenu(null);
                      }}
                    >
                      <Plus size={14} />
                      <span>New group…</span>
                    </button>
                  </div>
                )}
              </div>
              <div className="menu-separator" role="separator" />
              <button
                role="menuitem"
                onClick={() => {
                  patchThread(menuThread.id, { archived: !menuThread.archived, pinned: menuThread.archived ? menuThread.pinned : false });
                  setThreadMenu(null);
                }}
              >
                {menuThread.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                <span>{menuThread.archived ? 'Unarchive' : 'Archive'}</span>
              </button>
              <button
                role="menuitem"
                className="danger-menu-item"
                disabled={pending?.threadId === menuThread.id}
                onClick={() => { setDeleteId(menuThread.id); setThreadMenu(null); }}
              >
                <Trash2 size={14} />
                <span>Delete</span>
              </button>
            </AnchoredPopover>
          )}
        </AnimatePresence>
      </aside>
      <main className="chat-main">
        <header className="chat-header">
          <h2 className="chat-title" title={thread?.title}>
            {thread?.title || 'New chat'}
          </h2>
          <div className="chat-header-actions">
            {threadChanges.length > 0 && (
              <button
                type="button"
                className="chat-header-changes"
                title="Review all file changes in this chat"
                onClick={() => setChangesView({ title: 'Changes in this chat', files: threadChanges })}
              >
                <FileDiff size={15} aria-hidden="true" />
                <span>{threadChanges.length} {threadChanges.length === 1 ? 'file' : 'files'}</span>
              </button>
            )}
            <button
              className="icon-button"
              disabled={!visibleMessages.length}
              aria-label="Export chat"
              title="Export as Markdown"
              onClick={exportChat}
            >
              <Download size={16} />
            </button>
            <button
              className="icon-button"
              disabled={!thread || pendingHere}
              aria-label="Delete chat"
              title="Delete chat"
              onClick={() => thread && setDeleteId(thread.id)}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </header>
        <div className="chat-body">
          <div
            ref={conversation}
            className={`chat-conversation ${visibleMessages.length || pendingHere ? 'has-messages' : ''}`}
            onScroll={() => {
              const surface = conversation.current;
              if (!surface) return;
              const bottom = surface.scrollHeight - surface.scrollTop - surface.clientHeight < 80;
              followOutput.current = bottom;
              setAtBottom(bottom);
            }}
          >
            {!visibleMessages.length && !pendingHere && !thread?.error ? (
              <div className="chat-welcome">
                <div className="chat-welcome-mark">{logo(26)}</div>
                <h1>What can I help with?</h1>
                <p>
                  {chosenProject
                    ? `Chatting with ${providerNames[chosenProvider]} in ${chosenProject.name}.`
                    : `Ask ${providerNames[chosenProvider]} anything, or pick a project to work with your code.`}
                </p>
                {connectionError ? (
                  <div className="chat-welcome-alert" role="alert">
                    <AlertCircle size={15} aria-hidden="true" />
                    <span>{connectionError}</span>
                    <button className="text-button" onClick={() => setSettings(true)}>
                      Open settings
                    </button>
                  </div>
                ) : !chosenModel && !checking ? (
                  <button className="primary-button" onClick={() => setSettings(true)}>
                    Choose a model
                  </button>
                ) : null}
                <div className="chat-starters">
                  {starters.map((item) => (
                    <button
                      key={item.title}
                      type="button"
                      className="chat-starter"
                      onClick={() => {
                        edit({ draft: item.prompt });
                        focusComposer();
                      }}
                    >
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="chat-messages">
                {visibleMessages.map((message, index) => {
                  const key = `${thread!.id}:${index}`;
                  const realIndex = thread!.messages.indexOf(message);
                  return message.role === 'user' ? (
                    editing?.index === realIndex ? (
                      <article className="chat-message user editing" key={index}>
                        <textarea
                          className="chat-edit-box"
                          aria-label="Edit message"
                          autoFocus
                          value={editing.value}
                          maxLength={100000}
                          onChange={(event) => setEditing({ ...editing, value: event.target.value })}
                          onFocus={(event) => event.target.setSelectionRange(event.target.value.length, event.target.value.length)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') setEditing(null);
                            else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && editing.value.trim() && editing.value !== message.content)
                              resendFrom(realIndex, editing.value, message.attachments);
                          }}
                        />
                        <div className="chat-edit-actions">
                          <span
                            className="chat-edit-info"
                            title="Saving restarts the conversation from this message. Later messages are removed."
                          >
                            <Info size={14} aria-hidden="true" />
                          </span>
                          <button type="button" className="chat-edit-cancel" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="chat-edit-save"
                            disabled={!editing.value.trim() || editing.value === message.content}
                            onClick={() => resendFrom(realIndex, editing.value, message.attachments)}
                          >
                            Save
                          </button>
                        </div>
                      </article>
                    ) : (
                    <article className="chat-message user" key={index} ref={riseInIfSent(key)}>
                      <div className="message-content">
                        <p>{message.content}</p>
                        {!!message.attachments?.length && <ChatAttachments files={message.attachments} />}
                      </div>
                      <div className="chat-message-actions">
                        <button
                          className="chat-action"
                          aria-label={`Retry message ${index + 1}`}
                          title="Retry"
                          disabled={!!pending}
                          onClick={() => resendFrom(realIndex, message.content, message.attachments)}
                        >
                          <RotateCcw size={13} />
                        </button>
                        <button
                          className="chat-action"
                          aria-label={`Edit message ${index + 1}`}
                          title="Edit"
                          disabled={!!pending}
                          onClick={() => setEditing({ index: realIndex, value: message.content })}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="chat-action"
                          aria-label={`Copy message ${index + 1}`}
                          title={copied === key ? 'Copied' : 'Copy'}
                          onClick={() => copy(message.content, key)}
                        >
                          {copied === key ? <Check size={13} /> : <Copy size={13} />}
                        </button>
                      </div>
                    </article>
                    )
                  ) : (
                    <article className="chat-message assistant" key={index}>
                      <div className="chat-avatar">{logo(15)}</div>
                      <div className="chat-message-body">
                        <div className="message-content">
                          {!!message.activities?.length && <ChatActivity activities={message.activities} root={projectRoot} onOpenFile={onOpenFile && ((path) => onOpenFile(thread!.projectId, path))} />}
                          <MarkdownMessage
                            content={message.content}
                            onError={reportMarkdownError}
                          />
                          {!!message.activities?.length && (() => {
                            const files = collectChanges(message.activities);
                            return <ChangesSummary files={files} onReview={() => setChangesView({ title: 'Changes in this response', files })} />;
                          })()}
                        </div>
                        <div className="chat-message-actions">
                          <button
                            className="chat-action"
                            aria-label={`Copy message ${index + 1}`}
                            title={copied === key ? 'Copied' : 'Copy'}
                            onClick={() => copy(message.content, key)}
                          >
                            {copied === key ? <Check size={13} /> : <Copy size={13} />}
                            <span>{copied === key ? 'Copied' : 'Copy'}</span>
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
                {pendingHere && (
                  <article className="chat-message assistant streaming" aria-live="polite">
                    <div className="chat-avatar">{logo(15)}</div>
                    <div className="chat-message-body">
                      <div className="message-content">
                        <ChatActivity activities={streamActivities} root={projectRoot} onOpenFile={onOpenFile && ((path) => onOpenFile(thread!.projectId, path))} />
                        {streamText ? (
                          <MarkdownMessage
                            content={streamText}
                            onError={reportMarkdownError}
                          />
                        ) : (
                          <span className="chat-typing" role="status" aria-label="Generating response">
                            <i />
                            <i />
                            <i />
                          </span>
                        )}
                      </div>
                    </div>
                  </article>
                )}
                {thread?.error && isStopped(thread.error) && (
                  <div className="chat-error interrupted" role="status">
                    <Info size={16} aria-hidden="true" />
                    <p>{providerNames[chosenProvider]}’s response was interrupted.</p>
                    <div className="chat-error-actions">
                      <button type="button" disabled={!!pending} onClick={editLastPrompt}>
                        Edit prompt
                      </button>
                      <button type="button" disabled={!!pending} onClick={() => send(true)}>
                        Try again
                      </button>
                    </div>
                  </div>
                )}
                {thread?.error && !isStopped(thread.error) && (
                  <div className="chat-error" role="alert">
                    <AlertCircle size={16} aria-hidden="true" />
                    <p>{thread.error}</p>
                    <button
                      className="secondary-button"
                      disabled={!!pending}
                      onClick={() => send(true)}
                    >
                      <RotateCcw size={13} aria-hidden="true" />
                      Retry response
                    </button>
                  </div>
                )}
                <div ref={end} className="chat-end" />
              </div>
            )}
          </div>
          <AnimatePresence>
            {!atBottom && !!visibleMessages.length && (
              <motion.button
                key="scroll-bottom"
                className="chat-scroll-bottom"
                aria-label="Scroll to latest message"
                onClick={scrollToEnd}
                initial={motionReduced() ? false : { opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1, transition: { duration: motionReduced() ? 0 : 0.16, ease: [0.16, 1, 0.3, 1] } }}
                exit={motionReduced() ? { opacity: 1, scale: 1, transition: { duration: 0 } } : { opacity: 0, scale: 0.85, transition: { duration: 0.12 } }}
              >
                <ArrowDown size={16} />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
        <div className="chat-compose-wrap">
          {storageError && (
            <div className="chat-notice" role="alert">
              <AlertCircle size={14} aria-hidden="true" />
              <span>{storageError}</span>
              <button
                className="chat-notice-close"
                aria-label="Dismiss message"
                onClick={() => setStorageError('')}
              >
                <X size={13} />
              </button>
            </div>
          )}
          <div className="chat-context-row">
            <ChatSelect
              label="Chat project"
              heading="Project"
              compact
              title="Project"
              className="chat-context-chip"
              icon={<FolderOpen size={14} aria-hidden="true" />}
              value={chosenProjectId}
              disabled={pendingHere}
              onChange={changeProject}
              options={[
                {
                  value: '',
                  label: 'No project',
                  description: 'General chat without file access',
                  icon: <MessageSquare size={14} />,
                },
                ...projects.map((p) => ({
                  value: p.id,
                  label: p.name,
                  description: p.root,
                  icon: <FolderOpen size={14} />,
                })),
              ]}
            />
            {attachable && (
              <label className={`chat-attach chat-context-chip ${includeFile ? 'on' : ''}`} title={attachable.path}>
                <input
                  type="checkbox"
                  aria-label={`Include ${attachable.path} with each request`}
                  checked={includeFile}
                  onChange={(event) => setIncludeFile(event.target.checked)}
                />
                <Paperclip size={12} aria-hidden="true" />
                <span>{attachable.path.split('/').pop()}</span>
                <em>{includeFile ? 'Attached' : 'Attach file'}</em>
              </label>
            )}
          </div>
          <div className="chat-composer">
            {!!draftAttachments.length && <ChatAttachments files={draftAttachments} onRemove={(id) => edit({ draftAttachments: draftAttachments.filter((file) => file.id !== id) })} />}
            <input type="file" multiple className="chat-attachment-input" ref={uploadInput} aria-label="Choose files to attach" hidden
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = '';
                void attachFiles(files);
              }} />
            <div className="chat-compose-line">
            <textarea
              ref={composer}
              aria-label="Message"
              placeholder="Describe a task or ask a question"
              rows={1}
              maxLength={100000}
              value={thread?.draft || ''}
              disabled={!loaded}
              onPaste={(event) => {
                if (!event.clipboardData.files.length) return;
                event.preventDefault();
                void attachFiles(Array.from(event.clipboardData.files));
              }}
              onChange={(event) => edit({ draft: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            {pendingHere ? (
              <button
                className="chat-send stop"
                aria-label="Stop response"
                title="Stop response"
                onClick={() =>
                  api
                    .chatCancel(pending!.requestId)
                    .catch((error) => setStorageError(cleanError(error)))
                }
              >
                <Square size={11} weight="fill" />
              </button>
            ) : (
              <button
                className="chat-send"
                disabled={!loaded || uploading || (!thread?.draft.trim() && !draftAttachments.length) || busyElsewhere}
                aria-label="Send message"
                title={busyElsewhere ? 'Another chat is still responding' : 'Send message'}
                onClick={() => send()}
              >
                <CornerDownLeft size={16} />
              </button>
            )}
            </div>
          </div>
          <div className="chat-compose-toolbar">
              <div className="chat-compose-tools">
                <button type="button" className="chat-voice-button" aria-label="Attach files" title="Attach images or code files · paste images or drop files here"
                  disabled={!loaded || uploading || !!pending} onClick={() => uploadInput.current?.click()}>
                  <Paperclip size={15} />
                </button>
                <button
                  className={`chat-voice-button ${listening ? 'active listening' : ''}`}
                  aria-label={listening ? 'Stop voice chat' : 'Start voice chat'}
                  title={listening ? 'Stop voice chat' : 'Start voice chat'}
                  onClick={startVoice}
                >
                  <Mic size={15} />
                </button>
                <button
                  className={`chat-voice-button ${speakReplies ? 'active' : ''}`}
                  aria-label={speakReplies ? 'Turn off spoken replies' : 'Turn on spoken replies'}
                  title={speakReplies ? 'Turn off spoken replies' : 'Turn on spoken replies'}
                  onClick={() => {
                    setSpeakReplies(!speakReplies);
                    if (speaking) api.voiceStop().then(() => setSpeaking(false));
                  }}
                >
                  {speakReplies ? <Volume2 size={15} /> : <VolumeX size={15} />}
                </button>
                {chosenProvider !== 'ollama' && (
                  <ChatSelect
                    label="Chat permissions"
                    heading={chosenProvider === 'claude' ? 'Mode' : 'Permissions'}
                    compact
                    title={chosenProjectId ? 'Permissions' : 'Select a project to enable agent actions'}
                    value={chosenPermission}
                    disabled={!!pending || !chosenProjectId}
                    onChange={(value) => {
                      edit({ permission: value as Permission });
                      setPermission(value as Permission);
                    }}
                    options={
                      chosenProvider === 'claude'
                        ? [
                            { value: 'auto', label: 'Auto', description: 'Claude handles permission decisions' },
                            { value: 'ask', label: 'Manual', description: 'Always ask before making changes', badge: 'Default' },
                            { value: 'edits', label: 'Accept edits', description: 'Automatically accept all file edits' },
                            { value: 'plan', label: 'Plan', description: 'Create a plan before making changes' },
                            { value: 'full', label: 'Bypass permissions', footer: true, trailing: 'Enable' },
                          ]
                        : [
                            {
                              value: 'ask',
                              label: 'Ask for approval',
                              description: chosenProvider === 'codex' ? 'Project edits allowed; ask for extra access' : 'Ask before restricted commands and edits',
                              badge: 'Default',
                            },
                            { value: 'auto', label: 'Approve safe actions', description: 'Only ask for risky actions' },
                            { value: 'full', label: 'Full access', footer: true, trailing: 'Enable' },
                          ]
                    }
                  />
                )}
                {uploading && <span role="status" className="chat-uploading">Attaching…</span>}
                {connectionError && (
                  <button
                    className="chat-connection-issue"
                    title={connectionError}
                    onClick={() => setSettings(true)}
                  >
                    <AlertCircle size={12} aria-hidden="true" />
                    Connection issue
                  </button>
                )}
              </div>
              <div className="chat-agent-controls">
                <button
                  type="button"
                  className={`chat-model-refresh ${checking ? 'spinning' : ''}`}
                  aria-label="Refresh chat models"
                  title={checking ? 'Loading models…' : 'Refresh models'}
                  disabled={!!pending || checking}
                  onClick={() => void connect()}
                >
                  <RefreshCw size={13} />
                </button>
                <ChatSelect
                  label="Chat provider"
                  heading="Provider"
                  compact
                  title="Provider"
                  value={chosenProvider}
                  disabled={!!pending}
                  onChange={(value) => changeProvider(value as Provider)}
                  options={providerOptions.map((item) => ({
                    ...item,
                    icon: providerLogo(item.value, 15),
                  }))}
                />
                <ChatSelect
                  label="Chat model"
                  heading={`${providerNames[chosenProvider]} models`}
                  title="Model"
                  className="chat-select-model"
                  featured={4}
                  moreLabel="More models"
                  placeholder="Choose model"
                  value={chosenModel}
                  disabled={!!pending || checking}
                  onChange={selectModel}
                  emptyText={
                    connectionError
                      ? 'Models could not be loaded. Check Chat settings.'
                      : 'No models available yet.'
                  }
                  options={[
                    ...models.map((item) => ({
                      value: item.id,
                      label: item.name,
                      badge: item.isDefault ? 'Default' : undefined,
                    })),
                    ...(chosenModel && !models.some((item) => item.id === chosenModel)
                      ? [{ value: chosenModel, label: chosenModel, description: 'Custom model' }]
                      : []),
                  ]}
                />
                {chosenProvider !== 'ollama' && supportedEfforts.length > 0 && (
                  <ChatEffort
                    label="Reasoning effort"
                    title={`Reasoning effort for ${selectedModel?.name || chosenModel}`}
                    levels={reasoningLevels}
                    value={shownEffort}
                    defaultLevel={defaultEffort}
                    name={effortLabel}
                    disabled={!!pending || checking}
                    onChange={(level) => selectEffort(level === defaultEffort ? '' : level)}
                  />
                )}
              </div>
          </div>
        </div>
      </main>
      <AnimatePresence>
        {changesView && (
          <ChangesDialog
            title={changesView.title}
            files={changesView.files}
            root={projectRoot}
            onOpenFile={openChangedFile}
            onClose={() => setChangesView(null)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {settings && (
          <Modal title="Chat settings" onClose={() => setSettings(false)}>
            <p className="muted">
              Codex and Claude use their installed command-line tools and existing sign-ins. Ollama
              runs locally on your computer.
            </p>
            {chosenProvider === 'ollama' && (
              <label className="field-label">
                Server address
                <input
                  className="text-input"
                  aria-label="Ollama server address"
                  value={endpoint}
                  onChange={(event) => {
                    setEndpoint(event.target.value);
                    setModels([]);
                    setConnection('');
                    setConnectionError('');
                  }}
                />
              </label>
            )}
            <button className="secondary-button" disabled={checking} onClick={connect}>
              {checking ? 'Connecting…' : 'Connect / refresh models'}
            </button>
            {connectionError ? (
              <p role="alert" className="chat-settings-status error">
                {connectionError}
              </p>
            ) : (
              connection && (
                <p role="status" className="chat-settings-status">
                  {connection}
                </p>
              )
            )}
            <label className="field-label">
              Model
              <input
                className="text-input"
                aria-label="Chat model"
                list="chat-models"
                value={chosenModel}
                onChange={(event) => selectModel(event.target.value)}
                placeholder="Model name or alias"
              />
              <datalist id="chat-models">
                {models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </datalist>
            </label>
            <p className="muted">
              Agent chats can work in the selected project according to the permission setting.
              Attach a file to include its current editor contents.
            </p>
            <button className="primary-button" onClick={() => setSettings(false)}>
              Done
            </button>
          </Modal>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {approval && (
          <Modal key={approval.id} title={approval.title} onClose={() => answerApproval(false)}>
            <p className="muted">
              The agent is requesting permission for this action
              {approvals.length > 1 ? ` (${approvals.length - 1} more waiting)` : ''}:
            </p>
            <pre className="chat-approval-detail">{approval.detail}</pre>
            <div className="chat-approval-actions">
              <button className="secondary-button" onClick={() => answerApproval(false)}>
                Deny
              </button>
              <button className="primary-button" onClick={() => answerApproval(true)}>
                Allow once
              </button>
            </div>
          </Modal>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {groupPrompt && (
          <Modal title="New group" onClose={() => setGroupPrompt(null)}>
            <form
              className="chat-rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                saveGroupPrompt();
              }}
            >
              <p className="chat-delete-description">Name a group and this chat will move into it.</p>
              <input
                className="text-input"
                aria-label="Group name"
                placeholder="Group name"
                autoFocus
                maxLength={60}
                value={groupPrompt.value}
                onChange={(event) => setGroupPrompt({ ...groupPrompt, value: event.target.value })}
              />
              <div className="chat-approval-actions">
                <button type="button" className="secondary-button" onClick={() => setGroupPrompt(null)}>
                  Cancel
                </button>
                <button type="submit" className="primary-button" disabled={!groupPrompt.value.trim()}>
                  Create group
                </button>
              </div>
            </form>
          </Modal>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {renaming && (
          <Modal title="Rename chat" onClose={() => setRenaming(null)}>
            <form
              className="chat-rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                commitRename();
              }}
            >
              <p className="chat-delete-description">Give this chat a name you can recognise at a glance.</p>
              <input
                className="text-input"
                aria-label="Chat name"
                placeholder="Chat name"
                autoFocus
                maxLength={120}
                value={renaming.value}
                onChange={(event) => setRenaming({ ...renaming, value: event.target.value })}
                onFocus={(event) => event.target.select()}
              />
              <div className="chat-approval-actions">
                <button type="button" className="secondary-button" onClick={() => setRenaming(null)}>
                  Cancel
                </button>
                <button type="submit" className="primary-button" disabled={!renaming.value.trim()}>
                  Save name
                </button>
              </div>
            </form>
          </Modal>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {trustPrompt && (
          <Modal title="Trust this project’s Claude settings?" onClose={() => trustPrompt.resolve(null)}>
            <p className="chat-delete-description">
              This project includes Claude configuration ({trustPrompt.files.join(', ')}). Its
              settings can run commands automatically (hooks) and allow tools without asking. Trust
              it only if you trust whoever wrote this project.
            </p>
            <p className="chat-delete-description muted">
              If you don’t trust it, chat uses only your own Claude settings and ignores the
              project’s, including its CLAUDE.md.
            </p>
            <div className="chat-approval-actions">
              <button className="secondary-button" onClick={() => trustPrompt.resolve('ignored')}>
                Don’t trust
              </button>
              <button className="primary-button" onClick={() => trustPrompt.resolve('trusted')}>
                Trust project
              </button>
            </div>
          </Modal>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {deleteId && (
          <Modal title="Delete chat" onClose={() => setDeleteId(null)}>
            <p className="chat-delete-description">
              Delete “{threads.find((t) => t.id === deleteId)?.title || 'this chat'}” and its draft
              from this device? This can’t be undone.
            </p>
            <div className="chat-approval-actions">
              <button className="secondary-button" onClick={() => setDeleteId(null)}>
                Cancel
              </button>
              <button
                className="danger-button"
                onClick={() => {
                  setThreads((previous) => previous.filter((t) => t.id !== deleteId));
                  if (active === deleteId) setActive(null);
                  setDeleteId(null);
                }}
              >
                Delete conversation
              </button>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}
