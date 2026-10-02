function normalizeSession(value) {
  const source = value && typeof value === 'object' ? value : {};
  const names = Array.isArray(source.workspaceNames) ? [...new Set(source.workspaceNames.filter((name) => typeof name === 'string' && name.trim() && name.length <= 40))] : [];
  const validNames = names.length ? names : ['Main'];
  const files = Array.isArray(source.files) ? source.files.filter((file) => file && typeof file.path === 'string' && typeof file.content === 'string' && typeof file.saved === 'string' && typeof file.revision === 'string').map((file) => ({ ...file, conflict: file.conflict && typeof file.conflict.content === 'string' && typeof file.conflict.revision === 'string' ? file.conflict : undefined })) : [];
  const presets = Array.isArray(source.terminalPresets) ? source.terminalPresets.filter((preset) => preset && typeof preset.label === 'string' && typeof preset.shell === 'string').map((preset) => ({ ...preset, workspaceName: typeof preset.workspaceName === 'string' && preset.workspaceName.trim() ? preset.workspaceName : 'Main' })) : [];
  for (const preset of presets) if (!validNames.includes(preset.workspaceName)) validNames.push(preset.workspaceName);
  const meta = {};
  const sourceMeta = source.workspaceMeta && typeof source.workspaceMeta === 'object' ? source.workspaceMeta : {};
  for (const name of validNames) {
    const entry = sourceMeta[name];
    if (!entry || typeof entry !== 'object') continue;
    const clean = {};
    for (const flag of ['pinned', 'unread', 'archived']) if (entry[flag] === true) clean[flag] = true;
    if (typeof entry.group === 'string' && entry.group.trim() && entry.group.length <= 40) clean.group = entry.group.trim();
    if (Object.keys(clean).length) meta[name] = clean;
  }
  return { files, terminalPresets: presets, workspaceNames: validNames, workspaceMeta: meta, activeWorkspace: validNames.includes(source.activeWorkspace) ? source.activeWorkspace : validNames[0], activeFile: files.some((file) => file.path === source.activeFile) ? source.activeFile : files.at(-1)?.path, layout: ['focus', 'build', 'terminal'].includes(source.layout) ? source.layout : 'terminal', terminalHeight: Number.isFinite(source.terminalHeight) ? Math.max(160, Math.min(1200, source.terminalHeight)) : 290 };
}
function normalizeState(value) {
  const projects = Array.isArray(value?.projects) ? value.projects.filter((project) => project && typeof project.id === 'string' && typeof project.root === 'string' && typeof project.name === 'string') : [];
  const runPresets = {};
  for (const project of projects) if (Array.isArray(value.runPresets?.[project.id])) runPresets[project.id] = normalizeRunPresets(value.runPresets[project.id]);
  return { projects, activeProject: projects.some((project) => project.id === value.activeProject) ? value.activeProject : projects[0]?.id || null, sessions: Object.fromEntries(projects.map((project) => [project.id, normalizeSession(value.sessions?.[project.id])])), runPresets };
}
function normalizeRunPresets(value) {
  if (!Array.isArray(value)) throw new Error('Invalid command presets.');
  return value.filter((preset) => preset && typeof preset.name === 'string' && typeof preset.command === 'string' && preset.name.length <= 200 && preset.command.length <= 10000).slice(0, 200).map(({ name, command }) => ({ name, command }));
}
// Chat threads live apart from workspaces.json because they grow with every
// message; the renderer re-validates each thread when it loads them.
function normalizeChat(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const input = source.settings && typeof source.settings === 'object' ? source.settings : {};
  const settings = {};
  for (const key of ['endpoint', 'model', 'effort', 'provider', 'permission']) if (typeof input[key] === 'string' && input[key].length <= 2048) settings[key] = input[key];
  if (typeof input.speakReplies === 'boolean') settings.speakReplies = input.speakReplies;
  const efforts = input.modelEfforts && typeof input.modelEfforts === 'object' && !Array.isArray(input.modelEfforts) ? input.modelEfforts : {};
  settings.modelEfforts = Object.fromEntries(Object.entries(efforts).filter(([key, effort]) => key.length <= 200 && typeof effort === 'string' && effort.length <= 20));
  return { threads: Array.isArray(source.threads) ? source.threads.filter((thread) => thread && typeof thread === 'object' && typeof thread.id === 'string') : [], active: typeof source.active === 'string' ? source.active : null, settings };
}
module.exports = { normalizeSession, normalizeState, normalizeRunPresets, normalizeChat };
