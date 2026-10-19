const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke =
  (channel) =>
  (...args) =>
    ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld('workspace', {
  bootstrap: invoke('app:bootstrap'),
  activateProject: invoke('project:activate'),
  renameWorkspace: invoke('workspace:rename'),
  createEntry: invoke('files:create'),
  renameEntry: invoke('files:rename'),
  trashEntry: invoke('files:trash'),
  searchContent: invoke('files:content'),
  gitStage: invoke('git:stage'),
  gitUnstage: invoke('git:unstage'),
  gitCommit: invoke('git:commit'),
  chatModels: invoke('chat:models'),
  chatSend: invoke('chat:send'),
  chatCancel: invoke('chat:cancel'),
  chatStoreAttachments: invoke('chat:attachments-store'),
  chatReadAttachment: invoke('chat:attachment-read'),
  onChatActivity: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('chat:activity', listener);
    return () => ipcRenderer.removeListener('chat:activity', listener);
  },
  onChatSession: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('chat:session', listener);
    return () => ipcRenderer.removeListener('chat:session', listener);
  },
  chatApproval: invoke('chat:approval'),
  voiceListen: invoke('voice:listen'),
  voiceSpeak: invoke('voice:speak'),
  voiceStop: invoke('voice:stop'),
  onChatApproval: (callback) => {
    const listener = (_event, approval) => callback(approval);
    ipcRenderer.on('chat:approval', listener);
    return () => ipcRenderer.removeListener('chat:approval', listener);
  },
  onChatChunk: (callback) => {
    const listener = (_event, chunk) => callback(chunk);
    ipcRenderer.on('chat:chunk', listener);
    return () => ipcRenderer.removeListener('chat:chunk', listener);
  },
  getUsage: invoke('usage:get'),
  onUsageChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('usage:changed', listener);
    return () => ipcRenderer.removeListener('usage:changed', listener);
  },
  openExternal: invoke('link:open'),
  onBeforeClose: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:closing', listener);
    return () => ipcRenderer.removeListener('app:closing', listener);
  },
  pickProject: invoke('project:pick'),
  removeProject: invoke('project:remove'),
  updateProject: invoke('project:update'),
  claudeSettings: invoke('project:claude-settings'),
  setClaudeSettings: invoke('project:set-claude-settings'),
  listFiles: invoke('files:list'),
  readFile: invoke('files:read'),
  saveFile: invoke('files:save'),
  searchFiles: invoke('files:search'),
  gitStatus: invoke('git:status'),
  gitDiff: invoke('git:diff'),
  saveSession: invoke('session:save'),
  pluginsState: invoke('plugins:state'),
  pluginsContributions: invoke('plugins:contributions'),
  pluginsDetails: invoke('plugins:details'),
  pluginsPickFolder: invoke('plugins:pick-folder'),
  pluginsPreview: invoke('plugins:preview'),
  pluginsCancelPreview: invoke('plugins:cancel-preview'),
  pluginsInstall: invoke('plugins:install'),
  pluginsSetEnabled: invoke('plugins:set-enabled'),
  pluginsUninstall: invoke('plugins:uninstall'),
  pluginsRunCommand: invoke('plugins:run-command'),
  pluginsMcpPlan: invoke('plugins:mcp-plan'),
  pluginsMcpAdd: invoke('plugins:mcp-add'),
  pluginsMcpLogin: invoke('plugins:mcp-login'),
  pluginsMcpRemove: invoke('plugins:mcp-remove'),
  pluginsRefreshPublic: invoke('plugins:refresh-public'),
  pluginsCatalog: invoke('plugins:catalog'),
  pluginsAddMarketplace: invoke('plugins:add-marketplace'),
  pluginsRefreshMarketplace: invoke('plugins:refresh-marketplace'),
  pluginsRemoveMarketplace: invoke('plugins:remove-marketplace'),
  onPluginsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('plugins:changed', listener);
    return () => ipcRenderer.removeListener('plugins:changed', listener);
  },
  getRunPresets: invoke('run-presets:get'),
  saveRunPresets: invoke('run-presets:save'),
  getChatState: invoke('chat-state:get'),
  saveChatState: invoke('chat-state:save'),
  createTerminal: invoke('terminal:create'),
  listAgents: invoke('agents:list'),
  launchAgents: invoke('agents:launch'),
  attachTerminal: invoke('terminal:attach'),
  writeTerminal: invoke('terminal:write'),
  setCodexFullAccess: invoke('terminal:codex-full-access'),
  readTerminalClipboard: invoke('terminal:clipboard-read'),
  writeTerminalClipboard: invoke('terminal:clipboard-write'),
  // Where a dropped file lives on disk; empty for files that have no path.
  pathForFile: (file) => webUtils.getPathForFile(file),
  saveDroppedImage: invoke('terminal:drop-image-save'),
  downloadDroppedImage: invoke('terminal:drop-image-download'),
  resizeTerminal: invoke('terminal:resize'),
  closeTerminal: invoke('terminal:close'),
  windowAction: invoke('window:action'),
  browserHistory: invoke('browser:history'),
  removeBrowserHistory: invoke('browser:history-remove'),
  clearBrowsingData: invoke('browser:clear-data'),
  onBrowserHistoryChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('browser:history-changed', listener);
    return () => ipcRenderer.removeListener('browser:history-changed', listener);
  },
  setBrowserDevice: invoke('browser:set-device'),
  onBrowserCommand: (callback) => {
    const listener = (_event, guestId, action, value) => callback(guestId, action, value);
    ipcRenderer.on('browser:command', listener);
    return () => ipcRenderer.removeListener('browser:command', listener);
  },
  onBrowserOpenTab: (callback) => {
    const listener = (_event, url) => callback(url);
    ipcRenderer.on('browser:open-tab', listener);
    return () => ipcRenderer.removeListener('browser:open-tab', listener);
  },
  onTerminal: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('terminal:event', listener);
    return () => ipcRenderer.removeListener('terminal:event', listener);
  },
});
