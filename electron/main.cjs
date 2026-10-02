const { app, BrowserWindow, ipcMain, dialog, session, shell, clipboard, webContents, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./core.cjs');
const gitService = require('./git.cjs');
const chat = require('./chat.cjs');
const agentChat = require('./agent-chat.cjs');
const voice = require('./voice.cjs');
const { createAttachmentStore } = require('./chat-attachments.cjs');
let chatAttachments;
function attachments() {
  return chatAttachments ||= createAttachmentStore(path.join(app.getPath('userData'), 'chat-attachments'));
}
const { createUsageService } = require('./usage.cjs');
const { createUsageAdapters } = require('./usage-adapters.cjs');
const {
  normalizeState,
  normalizeSession,
  normalizeRunPresets,
  normalizeChat,
} = require('./state.cjs');
const chatRequests = new Map();
const chatApprovals = new Map();
let voiceController;
let usageService;
// Created on first use, once the data directory is settled.
function usage() {
  if (usageService) return usageService;
  const file = path.join(app.getPath('userData'), 'usage.json');
  const adapters = createUsageAdapters({
    // Compatibility requests follow Chromium's system proxy settings.
    fetch: (url, init) => net.fetch(url, init),
  });
  usageService = createUsageService({
    ...adapters,
    load: async () => JSON.parse(await fs.readFile(file, 'utf8')),
    save: (readings) => writeAtomic(file, JSON.stringify(readings)),
  });
  return usageService;
}
let closeApproved = false;
// Device modes for the embedded browser. `{chrome}` is replaced with the
// bundled Chromium version so the user agent stays believable after upgrades.
const browserDevices = {
  mobile: {
    width: 412,
    height: 915,
    touch: true,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chrome} Mobile Safari/537.36',
    navigatorPlatform: 'Linux armv81',
    platform: 'Android',
    platformVersion: '14.0.0',
    architecture: '',
    model: 'Pixel 8',
  },
  tablet: {
    width: 800,
    height: 1280,
    touch: true,
    mobile: false,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chrome} Safari/537.36',
    navigatorPlatform: 'Linux armv81',
    platform: 'Android',
    platformVersion: '14.0.0',
    architecture: '',
    model: 'SM-X710',
  },
  desktop: {
    width: 1366,
    height: 768,
    touch: false,
    mobile: false,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{chrome} Safari/537.36',
    navigatorPlatform: 'Win32',
    platform: 'Windows',
    platformVersion: '15.0.0',
    architecture: 'x86',
    model: '',
  },
};
const { listAgents } = require('./agents.cjs');
const { canDetachProcesses } = require('./job.cjs');
const { selectCodexFullAccess } = require('./terminal-permissions.cjs');
// The probe takes seconds (it compiles C# in PowerShell). Launches never wait
// for it: until it answers, terminals use the safe no-detach setup.
let detachable = null;
canDetachProcesses().then((value) => {
  detachable = value;
});

const MAX_TERMINALS_PER_WORKSPACE = 16;
let win;
let state = { projects: [], activeProject: null, sessions: {}, runPresets: {} };
// A project passed with --project= opens even when Settings starts with no project.
let launchProject = null;
let stateFile;
let saveQueue = Promise.resolve();
// null until the renderer saves once, so it can import older localStorage chats.
let chatState = null;
let chatFile;
let chatSaveQueue = Promise.resolve();
const terminals = new Map();
const permissionChanges = new Map();
const devURL = process.env.SUPERAPP_DEV_URL;
function trustedDevURL(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      !!url.port &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
if (process.env.SUPERAPP_DATA_DIR)
  app.setPath('userData', path.resolve(process.env.SUPERAPP_DATA_DIR));
const shells =
  process.platform === 'win32'
    ? [
        {
          id: 'powershell',
          label: 'PowerShell',
          command: path.join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32/WindowsPowerShell/v1.0/powershell.exe',
          ),
          args: ['-NoLogo'],
        },
        { id: 'cmd', label: 'Command Prompt', command: process.env.ComSpec || 'cmd.exe', args: [] },
      ]
    : [{ id: 'default', label: 'Shell', command: process.env.SHELL || '/bin/bash', args: [] }];
function project(id) {
  const result = state.projects.find((p) => p.id === id);
  if (!result) throw new Error('Open this project first.');
  return result;
}
async function writeAtomic(file, json) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, json, { mode: 0o600 });
  await fs.rename(temp, file);
}
function persist() {
  const json = JSON.stringify(state, null, 2);
  saveQueue = saveQueue
    .catch(() => {})
    .then(() => writeAtomic(stateFile, json));
  return saveQueue;
}
function persistChat() {
  const snapshot = chatState;
  const json = JSON.stringify(chatState);
  chatSaveQueue = chatSaveQueue
    .catch(() => {})
    .then(() => writeAtomic(chatFile, json))
    .then(() => attachments().prune(snapshot));
  return chatSaveQueue;
}
async function addProject(folder) {
  const root = await fs.realpath(folder);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Select a project folder.');
  let found = state.projects.find((p) => p.root === root);
  if (!found) {
    found = { id: crypto.randomUUID(), root, name: path.basename(root) || root, pinned: false };
    state.projects.push(found);
  }
  state.activeProject = found.id;
  await persist();
  return found;
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      throw new Error('Untrusted request.');
    return fn(...args);
  });
}
function terminal(id) {
  const t = terminals.get(id);
  if (!t) throw new Error('Terminal is no longer available.');
  return t;
}
let createTerminal;
// Deferred terminal starts, one per event-loop turn: each ConPTY spawn blocks the
// main process for ~30ms, so IPC (the launch reply, resizes) runs in between.
const startQueue = [];
let startQueueScheduled = false;
function drainStartQueue() {
  if (startQueueScheduled || !startQueue.length) return;
  startQueueScheduled = true;
  setImmediate(() => {
    startQueueScheduled = false;
    startQueue.shift()();
    drainStartQueue();
  });
}
/** Stops a terminal's process; one still waiting to start never starts. */
function stopTerminal(t) {
  if (t.exited) return;
  if (t.proc) t.proc.kill();
  else t.exited = true;
}
function workspaceTerminalCount(projectId, workspaceName) {
  const name = workspaceName || 'Main';
  return [...terminals.values()].filter(
    (item) => item.projectId === projectId && item.workspaceName === name && !item.exited,
  ).length;
}
let agentScan = null;
let cachedAgents = null;
let agentsCheckedAt = 0;
function availableAgents(fresh = false) {
  if (agentScan) return agentScan;
  if (!fresh && cachedAgents && Date.now() - agentsCheckedAt < 1500)
    return Promise.resolve(cachedAgents);
  agentScan = listAgents()
    .then((agents) => {
      cachedAgents = agents;
      agentsCheckedAt = Date.now();
      return agents;
    })
    .finally(() => {
      agentScan = null;
    });
  return agentScan;
}
function registerIPC() {
  availableAgents();
  handle('agents:list', async (id, workspaceName, fresh) => {
    project(id);
    // Answer from the last scan so the picker can launch at once; a stale scan
    // is refreshed in the background (Refresh still waits for a fresh one).
    let agents = fresh !== true && cachedAgents;
    if (agents) {
      if (Date.now() - agentsCheckedAt >= 1500) availableAgents().catch(() => {});
    } else agents = await availableAgents(fresh === true);
    return {
      agents: agents.map(({ executable, ...agent }) => agent),
      remaining: Math.max(
        0,
        MAX_TERMINALS_PER_WORKSPACE - workspaceTerminalCount(id, workspaceName),
      ),
    };
  });
  handle('agents:launch', async (id, selections, shellId, workspaceName) => {
    project(id);
    const targetWorkspace = workspaceName || 'Main';
    if (!Array.isArray(selections) || !selections.length || selections.length > 9)
      throw new Error('Select at least one agent.');
    // Reuse the last scan; rescan only when a selection isn't in it (just installed).
    let available = cachedAgents || (await availableAgents());
    if (
      selections.some(
        (selection) => !available.find((a) => a.id === selection?.agentId)?.installed,
      )
    )
      available = await availableAgents(true);
    const seen = new Set();
    let total = 0;
    for (const selection of selections) {
      const agent = available.find((a) => a.id === selection.agentId);
      if (!agent || !agent.installed)
        throw new Error(
          `${agent?.label || 'Agent'} is not available on PATH. Refresh the list after installing it.`,
        );
      if (
        seen.has(agent.id) ||
        !Number.isInteger(selection.count) ||
        selection.count < 1 ||
        selection.count > MAX_TERMINALS_PER_WORKSPACE
      )
        throw new Error('Invalid terminal count.');
      seen.add(agent.id);
      total += selection.count;
    }
    const remaining = Math.max(
      0,
      MAX_TERMINALS_PER_WORKSPACE - workspaceTerminalCount(id, targetWorkspace),
    );
    if (total > remaining)
      throw new Error(
        `Only ${remaining} terminal slots are available in this workspace. Reduce the count or close existing terminals.`,
      );
    const created = [],
      errors = [];
    const canDetach = detachable === true;
    for (const selection of selections) {
      const found = available.find((a) => a.id === selection.agentId);
      const agent =
        found.id === 'codex' && !canDetach ? { ...found, args: ['--no-daemon'] } : found;
      for (let index = 0; index < selection.count; index++) {
        try {
          // Reply with every pane first and start the processes afterwards, so the
          // panes appear at once instead of after N serial ConPTY spawns.
          created.push(
            createTerminal(
              id,
              shellId,
              agent.id === 'terminal' ? undefined : agent,
              targetWorkspace,
              canDetach,
              true,
            ),
          );
        } catch (error) {
          errors.push(`${agent.label}: ${error.message}`);
          break;
        }
      }
    }
    return { created, errors };
  });
  handle('app:bootstrap', () => ({
    ...state,
    terminals: [...terminals.values()].map(({ proc, output, seq, cols, rows, pendingInput, ...info }) => info),
    shells: shells.map(({ id, label }) => ({ id, label })),
    launchProject,
  }));
  handle('project:pick', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Open project folder',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : addProject(result.filePaths[0]);
  });
  handle('project:remove', async (id) => {
    project(id);
    for (const [terminalId, item] of terminals) {
      if (item.projectId !== id) continue;
      stopTerminal(item);
      terminals.delete(terminalId);
    }
    state.projects = state.projects.filter((item) => item.id !== id);
    delete state.sessions[id];
    delete state.runPresets[id];
    if (state.activeProject === id) state.activeProject = state.projects[0]?.id || null;
    await persist();
    return state.activeProject;
  });
  handle('project:update', async (id, patch) => {
    const target = project(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      throw new Error('Invalid project update.');
    if (patch.pinned !== undefined) {
      if (typeof patch.pinned !== 'boolean') throw new Error('Invalid pin state.');
      target.pinned = patch.pinned;
    }
    await persist();
    return target;
  });
  handle('files:list', (id, relative, includeIgnored) => core.listFiles(project(id).root, relative, includeIgnored));
  handle('files:read', (id, relative) => core.readFile(project(id).root, relative));
  handle('files:save', (id, relative, content, revision) =>
    core.saveFile(project(id).root, relative, content, revision),
  );
  handle('files:search', (id, query) => core.searchFiles(project(id).root, query));
  handle('files:create', (id, relative, directory) =>
    core.createEntry(project(id).root, relative, directory === true),
  );
  handle('files:rename', (id, relative, next) =>
    core.renameEntry(project(id).root, relative, next),
  );
  handle('files:trash', async (id, relative) =>
    shell.trashItem(await core.trashTarget(project(id).root, relative)),
  );
  handle('files:content', (id, query, sensitive) =>
    core.searchContent(project(id).root, query, sensitive === true),
  );
  handle('git:status', (id) => gitService.status(project(id).root));
  handle('git:diff', (id, relative, staged) =>
    gitService.diff(project(id).root, relative, staged === true),
  );
  handle('git:stage', (id, relative) => gitService.stage(project(id).root, relative));
  handle('git:unstage', (id, relative) => gitService.unstage(project(id).root, relative));
  handle('git:commit', (id, message) => gitService.commit(project(id).root, message));
  handle('project:activate', async (id) => {
    project(id);
    state.activeProject = id;
    await persist();
  });
  handle('workspace:rename', (id, previous, next) => {
    project(id);
    if (typeof next !== 'string' || !next.trim() || next.length > 40)
      throw new Error('Invalid workspace name.');
    for (const item of terminals.values())
      if (item.projectId === id && item.workspaceName === previous) item.workspaceName = next;
  });
  handle('chat:models', (provider, endpoint, fresh) =>
    provider === 'ollama'
      ? chat.models(endpoint).then((names) => names.map((name) => ({ id: name, name })))
      : agentChat.models(provider, endpoint, undefined, fresh === true),
  );
  handle('chat:attachments-store', (files) => attachments().store(files));
  handle('chat:attachment-read', (id) => attachments().read(id));
  handle('chat:send', async (request) => {
    if (
      !request ||
      typeof request.id !== 'string' ||
      !request.id || request.id.length > 200 ||
      chatRequests.has(request.id) ||
      chatRequests.size >= 4
    )
      throw new Error('A chat request is already running.');
    const controller = new AbortController();
    chatRequests.set(request.id, controller);
    let timer;
    let stopped = false;
    const renewTimeout = () => {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error('The response timed out after 15 minutes without activity.')), 15 * 60 * 1000);
    };
    renewTimeout();
    const approvalResolvers = new Set();
    let chunkBuffer = '';
    let partialText = '';
    let sessionId = request.sessionId || null;
    const activityLog = new Map();
    let chunkTimer;
    const activityBuffer = new Map();
    let activityTimer;
    const emit = (channel, value) => {
      if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, value);
    };
    const flushChunks = () => {
      clearTimeout(chunkTimer);
      chunkTimer = undefined;
      if (chunkBuffer) emit('chat:chunk', { id: request.id, text: chunkBuffer });
      chunkBuffer = '';
    };
    const flushActivities = () => {
      clearTimeout(activityTimer);
      activityTimer = undefined;
      for (const activity of activityBuffer.values()) emit('chat:activity', { id: request.id, activity });
      activityBuffer.clear();
    };
    try {
      request = { ...request, attachments: await attachments().resolve(request.attachments) };
      const onChunk = (text) => {
        renewTimeout();
        partialText += text;
        chunkBuffer += text;
        if (!chunkTimer) chunkTimer = setTimeout(flushChunks, 40);
      };
      if (request.provider && request.provider !== 'ollama') {
        const cwd = request.projectId ? project(request.projectId).root : app.getPath('home');
        const response = await agentChat.send(
          { ...request, cwd },
          controller,
          onChunk,
          (approval) =>
            new Promise((resolve) => {
              if (controller.signal.aborted) return resolve(false);
              renewTimeout();
              const approvalId = crypto.randomUUID();
              const finish = (allowed) => {
                clearTimeout(approvalTimer);
                chatApprovals.delete(approvalId);
                approvalResolvers.delete(finish);
                controller.signal.removeEventListener('abort', declined);
                renewTimeout();
                resolve(allowed);
              };
              const declined = () => finish(false);
              const approvalTimer = setTimeout(declined, 5 * 60 * 1000);
              approvalResolvers.add(finish);
              chatApprovals.set(approvalId, finish);
              controller.signal.addEventListener('abort', declined, { once: true });
              emit('chat:approval', {
                ...approval,
                id: approvalId,
                requestId: request.id,
              });
            }),
          (activity) => {
            if (stopped) return;
            renewTimeout();
            if (!activityLog.has(activity.id) && activityLog.size >= 100) activityLog.delete(activityLog.keys().next().value);
            activityLog.set(activity.id, activity);
            if (!activityBuffer.has(activity.id) && activityBuffer.size >= 100) activityBuffer.delete(activityBuffer.keys().next().value);
            activityBuffer.set(activity.id, activity);
            if (!activityTimer) activityTimer = setTimeout(flushActivities, 40);
          },
          (id) => { sessionId = id; emit('chat:session', { id: request.id, sessionId: id }); },
          () => emit('usage:changed'),
        );
        return { ...response, activities: [...activityLog.values()] };
      }
      // Ollama receives native image inputs and labelled text context, while
      // persisted messages contain only lightweight attachment references.
      if (Array.isArray(request.messages)) {
        const messages = [];
        let totalBytes = 0;
        for (const message of request.messages) {
          const files = await attachments().resolve(message.attachments);
          totalBytes += files.reduce((total, file) => total + file.size, 0);
          if (totalBytes > 20 * 1024 * 1024) throw new Error('This conversation has over 20 MB of attachments. Start a new chat.');
          messages.push({ role: message.role, content: `${message.content}${files.filter((file) => file.kind === 'text').map((file) => `\n\nAttached file (${file.name}; source data):\n${file.content}`).join('')}`,
            ...(files.some((file) => file.kind === 'image') && { images: files.filter((file) => file.kind === 'image').map((file) => file.data) }) });
        }
        request = { ...request, messages };
      }
      const text = await chat.send(request, controller.signal, onChunk);
      return { text, sessionId: null };
    } catch (error) {
      const message = controller.signal.aborted
        ? controller.signal.reason?.message || 'Response stopped. You can continue or retry your message.'
        : error.message === 'fetch failed'
          ? 'Cannot connect to Ollama. Start the local server and check its address in Chat settings.'
          : error.message || String(error);
      // Include final state atomically: notifications may reach the renderer
      // after the invocation settles, especially for fast tools and stopping.
      return { error: message, text: partialText, sessionId, activities: [...activityLog.values()] };
    } finally {
      stopped = true;
      flushChunks();
      flushActivities();
      for (const finish of approvalResolvers) finish(false);
      clearTimeout(timer);
      chatRequests.delete(request.id);
    }
  });
  handle('chat:cancel', (id) => chatRequests.get(id)?.abort(new Error('Response stopped. Your conversation and any completed file changes are kept.')));
  handle('chat:approval', (id, allowed) => {
    const resolve = chatApprovals.get(id);
    if (!resolve) throw new Error('This approval is no longer active.');
    chatApprovals.delete(id);
    resolve(allowed === true);
  });
  handle('voice:listen', async () => {
    if (voiceController) throw new Error('Voice input is already active.');
    const controller = new AbortController();
    voiceController = controller;
    try {
      return await voice.listen(controller.signal);
    } finally {
      if (voiceController === controller) voiceController = undefined;
    }
  });
  handle('voice:speak', async (text) => {
    voiceController?.abort();
    const controller = new AbortController();
    voiceController = controller;
    try {
      await voice.speak(text, controller.signal);
    } finally {
      if (voiceController === controller) voiceController = undefined;
    }
  });
  handle('voice:stop', () => {
    voiceController?.abort();
    voiceController = undefined;
  });
  handle('usage:get', (mode) =>
    mode === 'cached' ? usage().peek() : usage().get({ force: mode === 'force' }),
  );
  handle('link:open', async (value) => {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid web link.');
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Only web links can be opened in your browser.');
    await shell.openExternal(url.href);
  });
  handle('run-presets:get', (id) => {
    project(id);
    return state.runPresets[id] || null;
  });
  handle('run-presets:save', async (id, presets) => {
    project(id);
    state.runPresets[id] = normalizeRunPresets(presets);
    await persist();
  });
  handle('chat-state:get', () => chatState);
  handle('chat-state:save', async (value) => {
    if (!value || JSON.stringify(value).length > 64 * 1024 * 1024)
      throw new Error('Chat history is too large. Delete older chats.');
    chatState = normalizeChat(value);
    await persistChat();
  });
  handle('session:save', async (id, value) => {
    project(id);
    if (!value || JSON.stringify(value).length > 64 * 1024 * 1024)
      throw new Error('Workspace session is too large.');
    state.sessions[id] = normalizeSession(value);
    for (const preset of state.sessions[id].terminalPresets) {
      const item = terminals.get(preset.terminalId);
      if (item?.projectId !== id) continue;
      if (typeof preset.label === 'string') item.label = preset.label.slice(0, 100);
      if (typeof preset.sessionTitle === 'string')
        item.sessionTitle = preset.sessionTitle.slice(0, 200);
    }
    await persist();
  });
  createTerminal = (id, shellId, agent, workspaceName = 'Main', detachable = true, defer = false) => {
    if (workspaceTerminalCount(id, workspaceName) >= MAX_TERMINALS_PER_WORKSPACE)
      throw new Error(
        `Close a terminal before opening more (${MAX_TERMINALS_PER_WORKSPACE} terminal limit for this workspace).`,
      );
    const selected = agent ? shells[0] : shells.find((s) => s.id === shellId) || shells[0];
    const root = project(id).root;
    const pty = require('node-pty');
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => typeof v === 'string'),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    // Give interactive CLIs the same terminal capabilities they have in a
    // modern terminal emulator, including the background colors used by the
    // Codex composer.
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'superapp';
    env.TERM_PROGRAM_VERSION = app.getVersion();
    // Codex uses WT_SESSION to enable the richer Windows terminal composer
    // colors when it is hosted inside a ConPTY-backed terminal.
    env.WT_SESSION ||= `superapp-${crypto.randomUUID()}`;
    const directAgent =
      !!agent?.executable && (process.platform !== 'win32' || /\.exe$/i.test(agent.executable));
    const batchAgent =
      !!agent?.executable && process.platform === 'win32' && /\.(cmd|bat)$/i.test(agent.executable);
    const agentArgs = agent?.args || [];
    const command =
      agent && directAgent
        ? agent.executable
        : batchAgent
          ? process.env.ComSpec || 'cmd.exe'
          : selected.command;
    const args = agent
      ? directAgent
        ? agentArgs
        : batchAgent
          ? // A string is passed to ConPTY verbatim; node-pty would escape the quotes in an array.
            `/d /s /c "${[agent.executable, ...agentArgs].map((part) => `"${part}"`).join(' ')}"`
        : process.platform === 'win32'
          ? [
              '-NoLogo',
              '-NoProfile',
              '-Command',
              ['&', agent.executable, ...agentArgs]
                .map((part, index) => (index ? `'${part.replaceAll("'", "''")}'` : part))
                .join(' '),
            ]
          : [
              '-c',
              ['exec', agent.executable, ...agentArgs]
                .map((part, index) => (index ? `"${part.replaceAll('"', '\\"')}"` : part))
                .join(' '),
            ]
      : detachable || process.platform !== 'win32'
        ? selected.args
        : selected.id === 'cmd'
          ? ['/k', 'doskey codex=codex --no-daemon $*']
          : [
              ...selected.args,
              '-NoExit',
              '-Command',
              "function codex { $c = Get-Command codex -CommandType Application | Select-Object -First 1; & $c.Source --no-daemon @args }",
            ];
    const item = {
      id: crypto.randomUUID(),
      projectId: id,
      workspaceName,
      shell: selected.id,
      label: agent
        ? `${agent.label} ${1 + [...terminals.values()].filter((t) => t.projectId === id && t.agentId === agent.id).length}`
        : selected.label,
      agentId: agent?.id,
      // Null until the process has started; see `start` below.
      proc: null,
      // The size the renderer asked for before the process started.
      cols: 100,
      rows: 24,
      output: '',
      seq: 0,
      exited: false,
      startedAt: Date.now(),
    };
    const emit = (data) => {
      if (win && !win.isDestroyed())
        win.webContents.send('terminal:event', { id: item.id, seq: ++item.seq, ...data });
    };
    const finish = (exitCode) => {
      item.exited = true;
      item.exitCode = exitCode;
      item.finishedAt = Date.now();
      emit({ exitCode, at: item.finishedAt });
    };
    const start = () => {
      const proc = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: item.cols,
        rows: item.rows,
        cwd: root,
        env,
      });
      item.proc = proc;
      proc.onData((data) => {
        item.lastOutputAt = Date.now();
        item.output = (item.output + data).slice(-200000);
        emit({ data, at: item.lastOutputAt });
      });
      proc.onExit(({ exitCode }) => finish(exitCode));
      if (item.pendingInput) proc.write(item.pendingInput);
      delete item.pendingInput;
    };
    if (defer) {
      terminals.set(item.id, item);
      startQueue.push(() => {
        // Closed (or the app quit) before its turn came.
        if (item.exited || terminals.get(item.id) !== item) return;
        try {
          start();
        } catch (error) {
          const data = `\x1b[31m${item.label} could not start: ${error.message}\x1b[0m\r\n`;
          item.output += data;
          emit({ data, at: Date.now() });
          finish(-1);
        }
      });
      drainStartQueue();
    } else {
      start();
      terminals.set(item.id, item);
    }
    return {
      id: item.id,
      projectId: id,
      label: item.label,
      shell: selected.id,
      agentId: item.agentId,
      workspaceName,
      sessionTitle: agent?.label || selected.label,
      startedAt: item.startedAt,
      lastOutputAt: item.lastOutputAt,
    };
  };
  handle('terminal:create', async (id, shellId, workspaceName) =>
    createTerminal(id, shellId, undefined, workspaceName, detachable === true),
  );
  handle('terminal:attach', (id, workspaceName) => {
    const t = terminal(id);
    if (!t.workspaceName && workspaceName) t.workspaceName = workspaceName;
    return { output: t.output, seq: t.seq, exited: t.exited, exitCode: t.exitCode };
  });
  handle('terminal:write', (id, data) => {
    const t = terminal(id);
    if (typeof data !== 'string' || data.length > 100000)
      throw new Error('Invalid terminal input.');
    if (!t.exited) {
      if (/[\r\n]/.test(data)) t.lastInputAt = Date.now();
      if (t.proc) t.proc.write(data);
      else t.pendingInput = (t.pendingInput || '') + data;
    }
  });
  handle('terminal:codex-full-access', (id) => {
    const t = terminal(id);
    if (t.exited || !t.proc || t.agentId !== 'codex')
      throw new Error('Select a running Codex terminal.');
    if (permissionChanges.has(id)) return permissionChanges.get(id);
    const change = selectCodexFullAccess(t.proc).finally(() => permissionChanges.delete(id));
    permissionChanges.set(id, change);
    return change;
  });
  handle('terminal:clipboard-read', async () => {
    const [text, items] = await Promise.all([clipboard.readText(), clipboard.read()]);
    return {
      text,
      hasImage: items.some((item) => item.types.some((type) => type.startsWith('image/'))),
    };
  });
  handle('terminal:clipboard-write', (text) => {
    if (typeof text !== 'string') throw new Error('Invalid clipboard text.');
    return clipboard.writeText(text);
  });
  handle('terminal:resize', (id, cols, rows) => {
    const t = terminal(id);
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 2 ||
      cols > 1000 ||
      rows < 1 ||
      rows > 500
    )
      return;
    if (t.exited) return;
    if (t.proc) t.proc.resize(cols, rows);
    else Object.assign(t, { cols, rows });
  });
  handle('terminal:close', (id) => {
    stopTerminal(terminal(id));
    terminals.delete(id);
  });
  const browserGuest = (guestId) => {
    const guest = Number.isInteger(guestId) ? webContents.fromId(guestId) : undefined;
    if (!guest || guest.getType() !== 'webview' || guest.hostWebContents !== win.webContents)
      throw new Error('Browser view is no longer available.');
    return guest;
  };
  handle('browser:clear-history', (guestId) => {
    // History belongs to the view, not the session's cache or site storage.
    // Validate the view before making any changes and preserve sign-ins.
    browserGuest(guestId).navigationHistory.clear();
  });
  // Same emulation DevTools device mode uses: mobile viewport rules, screen
  // size, touch support and user agent (including client hints), so sites
  // pick the layout and code paths they would serve that device. Sizes match
  // DEVICES in src/WorkspaceBrowser.tsx. The viewport size and pixel ratio
  // are left alone: the renderer sizes the frame and zooms the page so it is
  // drawn at the resolution it is shown at, which keeps it sharp.
  handle('browser:set-device', async (guestId, mode) => {
    const guest = browserGuest(guestId);
    const device = Object.hasOwn(browserDevices, mode) ? browserDevices[mode] : undefined;
    if (mode !== 'responsive' && !device) throw new Error('Unknown device mode.');
    const debug = guest.debugger;
    if (!device) {
      if (debug.isAttached()) debug.detach();
      return;
    }
    if (!debug.isAttached()) debug.attach('1.3');
    const chromeMajor = process.versions.chrome.split('.')[0];
    const landscape = device.width > device.height;
    await debug.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 0,
      height: 0,
      deviceScaleFactor: 0,
      mobile: device.touch,
      screenWidth: device.width,
      screenHeight: device.height,
      screenOrientation: { type: landscape ? 'landscapePrimary' : 'portraitPrimary', angle: 0 },
    });
    await debug.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: device.touch,
      ...(device.touch && { maxTouchPoints: 5 }),
    });
    await debug.sendCommand('Emulation.setUserAgentOverride', {
      userAgent: device.userAgent.replace('{chrome}', `${chromeMajor}.0.0.0`),
      platform: device.navigatorPlatform,
      userAgentMetadata: {
        brands: [
          { brand: 'Chromium', version: chromeMajor },
          { brand: 'Google Chrome', version: chromeMajor },
          { brand: 'Not_A Brand', version: '99' },
        ],
        platform: device.platform,
        platformVersion: device.platformVersion,
        architecture: device.architecture,
        model: device.model,
        mobile: device.mobile,
      },
    });
  });
  handle('window:action', async (action) => {
    if (action === 'minimize') win.minimize();
    if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    if (action === 'close') win.close();
    if (action === 'close-ready') {
      await Promise.all([saveQueue, chatSaveQueue]);
      closeApproved = true;
      win.close();
    }
    // The renderer cannot reload itself: will-navigate blocks every
    // renderer-initiated navigation, location.reload() included.
    if (action === 'reload') {
      await Promise.all([saveQueue, chatSaveQueue]);
      win.webContents.reload();
    }
  });
}
app
  .whenReady()
  .then(async () => {
    stateFile = path.join(app.getPath('userData'), 'workspaces.json');
    try {
      const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      state = normalizeState(saved);
    } catch {
      /* First launch starts with an empty workspace. */
    }
    chatFile = path.join(app.getPath('userData'), 'chats.json');
    try {
      chatState = normalizeChat(JSON.parse(await fs.readFile(chatFile, 'utf8')));
    } catch (error) {
      // Missing: the renderer may import older chats from localStorage.
      // Unreadable: keep the file aside rather than overwriting it.
      if (error.code !== 'ENOENT') {
        await fs.rename(chatFile, `${chatFile}.unreadable-${Date.now()}`).catch(() => {});
        chatState = normalizeChat({});
      }
    }
    for (const arg of process.argv.filter((a) => a.startsWith('--project=')))
      launchProject = (await addProject(arg.slice(10))).id;
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    win = new BrowserWindow({
      width: 1277,
      height: 753,
      minWidth: 760,
      minHeight: 560,
      frame: false,
      backgroundColor: '#191713',
      title: 'Superapp',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: true,
      },
    });
    win.on('close', (event) => {
      if (!closeApproved && !win.webContents.isDestroyed()) {
        event.preventDefault();
        win.webContents.send('app:closing');
      }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    const browserPartition = 'persist:superapp-browser';
    const allowedBrowserURL = (value) => {
      try {
        const url = new URL(value);
        return !url.username && !url.password && (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
      } catch {
        return false;
      }
    };
    const browserSession = session.fromPartition(browserPartition);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
      if (params.partition !== browserPartition || params.src !== 'about:blank') {
        event.preventDefault();
        return;
      }
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
    });
    win.webContents.on('did-attach-webview', (_event, guest) => {
      guest.setWindowOpenHandler(() => ({ action: 'deny' }));
      guest.on('will-navigate', (event, url) => {
        if (!allowedBrowserURL(url)) event.preventDefault();
      });
      guest.on('will-redirect', (event, url) => {
        if (!allowedBrowserURL(url)) event.preventDefault();
      });
    });
    win.webContents.on('will-prevent-unload', (event) => {
      const response = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Keep working', 'Close app'],
        defaultId: 0,
        cancelId: 0,
        message: 'Close with unsaved edits?',
        detail:
          'Save your files before closing to ensure your latest changes are on disk. Running terminals will stop.',
      });
      if (response === 1) event.preventDefault();
      else closeApproved = false;
    });
    registerIPC();
    // `scripts/dev.mjs` may bind Vite to any available localhost port. Use
    // the URL it passed through instead of assuming the old default port;
    // otherwise `npm run dev` silently opens the stale production bundle.
    if (devURL && !app.isPackaged) {
      if (!trustedDevURL(devURL)) throw new Error('Invalid local development URL.');
      await win.loadURL(devURL);
    }
    else await win.loadFile(path.join(__dirname, '../dist/index.html'));
    win.show();
  })
  .catch((error) => {
    dialog.showErrorBox('Superapp could not start', error.message);
    app.quit();
  });
app.on('window-all-closed', () => {
  for (const controller of chatRequests.values()) controller.abort();
  for (const t of terminals.values()) stopTerminal(t);
  app.quit();
});
