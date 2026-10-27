// Self-update from GitHub Releases. Only a packaged, installed build can update;
// development runs and the unpacked `dir` build report `supported: false`.
function createUpdater({ app, send, loadUpdater = () => require('electron-updater').autoUpdater }) {
  let state = { status: 'idle', version: app.getVersion(), supported: app.isPackaged };
  let updater;
  const set = (patch) => {
    state = { ...state, ...patch };
    send(state);
  };
  function init() {
    if (updater || !state.supported) return updater;
    updater = loadUpdater();
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('checking-for-update', () => set({ status: 'checking', error: undefined }));
    updater.on('update-available', (info) => set({ status: 'downloading', latest: info.version, percent: 0 }));
    updater.on('update-not-available', () => set({ status: 'current', latest: undefined, checkedAt: Date.now() }));
    updater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
    updater.on('update-downloaded', (info) => set({ status: 'ready', latest: info.version, percent: 100, checkedAt: Date.now() }));
    updater.on('error', (error) => set({ status: 'error', error: String(error?.message || error).split('\n')[0] }));
    return updater;
  }
  return {
    state: () => state,
    async check() {
      if (!init()) return state;
      if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return state;
      try {
        await updater.checkForUpdates();
      } catch (error) {
        set({ status: 'error', error: String(error?.message || error).split('\n')[0] });
      }
      return state;
    },
    install() {
      if (state.status !== 'ready' || !updater) throw new Error('No update is ready to install.');
      updater.quitAndInstall(false, true);
    },
  };
}
module.exports = { createUpdater };
