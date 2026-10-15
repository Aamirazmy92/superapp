const fs = require('node:fs/promises');
const { NAME } = require('./manifest.cjs');

const RESERVED = ['local', 'git'];
const SHA = /^[0-9a-f]{40}$/;
const empty = () => ({ version: 1, plugins: [], marketplaces: [] });
const isText = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max;

function normalizeSource(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.kind === 'local' && isText(source.path)) return { kind: 'local', path: source.path };
  if (source.kind === 'git' && isText(source.url, 2048))
    return {
      kind: 'git',
      url: source.url,
      ...(isText(source.ref, 200) && { ref: source.ref }),
      ...(isText(source.path, 512) && { path: source.path }),
    };
  if (source.kind === 'marketplace' && isText(source.marketplace, 64) && isText(source.name, 64))
    return { kind: 'marketplace', marketplace: source.marketplace, name: source.name };
  return null;
}
function normalizePlugin(item) {
  if (!item || typeof item !== 'object') return null;
  const { name, marketplace, scope, projectId } = item;
  if (!isText(name, 64) || !NAME.test(name)) return null;
  if (!isText(marketplace, 64) || !NAME.test(marketplace)) return null;
  if (item.id !== `${name}@${marketplace}`) return null;
  if (scope !== 'user' && scope !== 'project') return null;
  if (scope === 'project' && !isText(projectId, 200)) return null;
  const source = normalizeSource(item.source);
  if (!source || !isText(item.version, 128) || !isText(item.installPath) || typeof item.enabled !== 'boolean') return null;
  return {
    id: item.id,
    name,
    marketplace,
    scope,
    ...(scope === 'project' && { projectId }),
    version: item.version,
    ...(SHA.test(item.sha) && { sha: item.sha }),
    source,
    installPath: item.installPath,
    installedAt: isText(item.installedAt, 64) ? item.installedAt : new Date(0).toISOString(),
    lastUpdated: isText(item.lastUpdated, 64) ? item.lastUpdated : new Date(0).toISOString(),
    enabled: item.enabled,
    ...(connections(item.connections).length && { connections: connections(item.connections) }),
  };
}
/** MCP servers Veyo added to a coding CLI for this install (recorded on success). */
function connections(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item) =>
        item && (item.cli === 'claude' || item.cli === 'codex') && isText(item.name, 64) && /^[A-Za-z0-9_-]+$/.test(item.name) &&
        isText(item.server, 64) && (item.scope === 'user' || item.scope === 'project'),
    )
    .slice(0, 50)
    .map(({ cli, name, server, scope, at }) => ({ cli, name, server, scope, ...(isText(at, 64) && { at }) }));
}
function normalizeMarketplace(item) {
  if (!item || typeof item !== 'object' || !isText(item.name, 64) || !NAME.test(item.name) || RESERVED.includes(item.name)) return null;
  const source = normalizeSource(item.source);
  if (!source || source.kind === 'marketplace') return null;
  return {
    name: item.name,
    source,
    addedAt: isText(item.addedAt, 64) ? item.addedAt : new Date(0).toISOString(),
    ...(isText(item.lastUpdated, 64) && { lastUpdated: item.lastUpdated }),
    ...(SHA.test(item.sha) && { sha: item.sha }),
    ...(item.builtin === true && { builtin: true }),
  };
}
function normalizeRegistry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty();
  const plugins = [];
  const keys = new Set();
  for (const item of Array.isArray(raw.plugins) ? raw.plugins : []) {
    const clean = normalizePlugin(item);
    if (!clean || keys.has(entryKey(clean))) continue;
    keys.add(entryKey(clean));
    plugins.push(clean);
  }
  const names = new Set();
  const marketplaces = [];
  for (const item of Array.isArray(raw.marketplaces) ? raw.marketplaces : []) {
    const clean = normalizeMarketplace(item);
    if (!clean || names.has(clean.name)) continue;
    names.add(clean.name);
    marketplaces.push(clean);
  }
  return { version: 1, plugins, marketplaces };
}

/** One install of a plugin: the same plugin may be installed per scope and project. */
function entryKey(entry) {
  return `${entry.id}|${entry.scope}|${entry.projectId || ''}`;
}

/*
 * The enabled installs that apply to a project (or to no project). A project
 * install of a plugin takes precedence over its user install.
 */
function activeEntries(entries, projectId) {
  const chosen = new Map();
  for (const entry of entries) {
    if (!entry.enabled) continue;
    if (entry.scope === 'project' && entry.projectId !== projectId) continue;
    const current = chosen.get(entry.name);
    if (!current || (current.scope === 'user' && entry.scope === 'project')) chosen.set(entry.name, entry);
  }
  return entries.filter((entry) => [...chosen.values()].includes(entry));
}

/** Another marketplace's plugin already using this name, if any. */
function conflictingInstall(entries, name, marketplace) {
  return entries.find((entry) => entry.name === name && entry.marketplace !== marketplace) || null;
}

/*
 * The registry file. Changes are applied to a copy and become current only once
 * written, so a failed write leaves both the file and memory as they were.
 */
function createRegistry(file, writeAtomic) {
  let current = empty();
  let queue = Promise.resolve();
  // 'unreadable' when the file existed but could not be used; it is kept aside.
  let status = 'missing';
  return {
    async load() {
      try {
        current = normalizeRegistry(JSON.parse(await fs.readFile(file, 'utf8')));
        status = 'ok';
      } catch (error) {
        status = error.code === 'ENOENT' ? 'missing' : 'unreadable';
        if (status === 'unreadable') await fs.rename(file, `${file}.unreadable-${Date.now()}`).catch(() => {});
        current = empty();
      }
      return current;
    },
    status: () => status,
    get: () => current,
    save(mutator) {
      const next = queue
        .catch(() => {})
        .then(async () => {
          const draft = structuredClone(current);
          const result = await mutator(draft);
          const clean = normalizeRegistry(draft);
          await writeAtomic(file, JSON.stringify(clean, null, 2));
          current = clean;
          return result;
        });
      queue = next;
      return next;
    },
  };
}

module.exports = { RESERVED, activeEntries, conflictingInstall, createRegistry, entryKey, normalizeRegistry };
