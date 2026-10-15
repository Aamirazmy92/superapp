const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { PluginError, copyTree, hashTree } = require('./files.cjs');
const { loadPlugin, NAME, SEMVER } = require('./manifest.cjs');
const { inside } = require('../core.cjs');
const { activeEntries, conflictingInstall, createRegistry, entryKey } = require('./registry.cjs');
const { createGit } = require('./git.cjs');
const { MARKETPLACE_FILES, MAX_BYTES, isUpdateAvailable, parseMarketplace, parseMarketplaceInput } = require('./marketplace.cjs');

const PREVIEW_TTL = 30 * 60 * 1000;
const MAX_PREVIEWS = 8;

function fail(message) {
  throw new PluginError(message);
}
const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const safeSegment = (value) => value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 80);

/** Counts shown in lists; the full contribution lists go to details and consent. */
function counts(contributes) {
  return Object.fromEntries(Object.entries(contributes).map(([kind, list]) => [kind, list.length]));
}
function summary(plugin) {
  return {
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    author: plugin.author,
    license: plugin.license,
    homepage: plugin.homepage,
    minAppVersion: plugin.minAppVersion,
    compatible: plugin.compatible,
    format: plugin.format,
    ...(plugin.manifestName && { manifestName: plugin.manifestName }),
    unsupported: plugin.unsupported,
    counts: counts(plugin.contributes),
  };
}
/** What changes between two versions: shown before an update is confirmed. */
function diffPlugins(before, after) {
  const describeRun = (item) => [item.run?.program ?? item.program, ...(item.run?.args ?? item.args ?? [])].join(' ');
  const describeServer = (server) => (server.type === 'stdio' ? [server.command, ...server.args].join(' ') : server.url);
  const compare = (kind, key, describe) => {
    const old = new Map((before?.contributes[kind] || []).map((item) => [item[key], item]));
    const next = new Map((after.contributes[kind] || []).map((item) => [item[key], item]));
    return {
      added: [...next.keys()].filter((name) => !old.has(name)),
      removed: [...old.keys()].filter((name) => !next.has(name)),
      changed: [...next.keys()].filter((name) => old.has(name) && describe(old.get(name)) !== describe(next.get(name))),
    };
  };
  return {
    fromVersion: before?.version ?? null,
    toVersion: after.version,
    commands: compare('commands', 'id', describeRun),
    agents: compare('agents', 'id', describeRun),
    mcpServers: compare('mcpServers', 'name', describeServer),
  };
}

/*
 * Plugin installs, enable state and contributions. Every operation that touches
 * disk goes through a staging folder first; nothing from a plugin is executed here.
 */
function createPluginService({ dataDir, appVersion, writeAtomic, git = createGit(), publicCatalog = null, onChange = () => {} }) {
  const root = path.join(dataDir, 'plugins');
  const cacheDir = path.join(root, 'cache');
  const stagingDir = path.join(root, 'staging');
  const marketplacesDir = path.join(root, 'marketplaces');
  const registry = createRegistry(path.join(root, 'installed.json'), writeAtomic);
  const loaded = new Map();
  const previews = new Map();
  let ready;

  async function loadEntry(entry) {
    try {
      const plugin = await loadPlugin(entry.installPath, {
        appVersion,
        fallbackVersion: entry.version,
        listedName: entry.source.kind === 'marketplace' ? entry.name : undefined,
      });
      if (plugin.name !== entry.name) fail(`The installed files name a different plugin ("${plugin.name}").`);
      loaded.set(entry.installPath, { plugin });
    } catch (error) {
      loaded.set(entry.installPath, { error: error instanceof PluginError ? error.message : `The installed files could not be read: ${error.message}` });
    }
  }
  function init() {
    ready ||= (async () => {
      await fs.mkdir(cacheDir, { recursive: true });
      // Previews never survive a restart; consent is given per preview.
      await fs.rm(stagingDir, { recursive: true, force: true });
      await fs.mkdir(stagingDir, { recursive: true });
      await registry.load();
      await Promise.all(registry.get().plugins.map(loadEntry));
      // An unreadable registry was set aside; keep its plugins' files for recovery.
      if (registry.status() !== 'unreadable') await sweepCache();
    })();
    return ready;
  }
  function find(key) {
    const entry = registry.get().plugins.find((item) => entryKey(item) === key);
    if (!entry) fail('This plugin is no longer installed.');
    return entry;
  }
  async function removeUnused(installPath) {
    if (registry.get().plugins.some((item) => item.installPath === installPath)) return;
    loaded.delete(installPath);
    if (path.relative(cacheDir, installPath).startsWith('..')) return;
    // Best effort: a running plugin command can hold files open on Windows. The
    // registry no longer points here, and start-up sweeps what is left.
    await fs.rm(installPath, { recursive: true, force: true }).catch(() => {});
    // Tidy the now-empty plugin and marketplace folders; rmdir refuses non-empty ones.
    for (let dir = path.dirname(installPath); dir !== cacheDir && !path.relative(cacheDir, dir).startsWith('..'); dir = path.dirname(dir))
      if (!(await fs.rmdir(dir).then(() => true, () => false))) break;
  }
  /** Removes cached plugin folders that no install refers to any more. */
  async function sweepCache() {
    const used = new Set(registry.get().plugins.map((entry) => path.resolve(entry.installPath)));
    const list = (dir) => fs.readdir(dir, { withFileTypes: true }).then((items) => items.filter((item) => item.isDirectory()), () => []);
    for (const market of await list(cacheDir))
      for (const plugin of await list(path.join(cacheDir, market.name)))
        for (const version of await list(path.join(cacheDir, market.name, plugin.name))) {
          const dir = path.join(cacheDir, market.name, plugin.name, version.name);
          if (!used.has(path.resolve(dir))) await removeUnused(dir);
        }
  }
  async function discardPreview(id) {
    const preview = previews.get(id);
    if (!preview) return;
    previews.delete(id);
    clearTimeout(preview.timer);
    await fs.rm(preview.dir, { recursive: true, force: true });
  }

  // Marketplaces -----------------------------------------------------------
  const catalogs = new Map();
  let gitChecked = null;
  const marketplaceRoot = (market) => (market.source.kind === 'local' ? market.source.path : path.join(marketplacesDir, market.name));
  const sourceDisplay = (source) => (source.kind === 'local' ? source.path : source.url);
  function gitAvailable() {
    gitChecked ||= git.available().catch(() => false);
    return gitChecked;
  }
  async function readIndex(dir) {
    for (const rel of MARKETPLACE_FILES) {
      const file = path.join(dir, ...rel.split('/'));
      let stat;
      try {
        stat = await fs.lstat(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) fail('The marketplace index is not a regular file.');
      if (stat.size > MAX_BYTES) fail('The marketplace index is larger than 4 MB.');
      let raw;
      try {
        raw = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, ''));
      } catch (error) {
        fail(`The marketplace index is not valid JSON: ${error.message}`);
      }
      return parseMarketplace(raw);
    }
    fail('No marketplace index found. Expected .veyo-plugin/marketplace.json (or .claude-plugin/marketplace.json).');
  }
  /** A marketplace's parsed index, cached until it is refreshed. */
  async function loadCatalog(market) {
    const key = `${market.lastUpdated || market.addedAt}|${market.sha || ''}`;
    const cached = catalogs.get(market.name);
    if (cached && cached.key === key) return cached;
    let result;
    try {
      const value = await readIndex(marketplaceRoot(market));
      if (value.name !== market.name) fail(`The marketplace now calls itself "${value.name}". Remove it and add it again.`);
      result = { key, value };
    } catch (error) {
      result = { key, error: error instanceof PluginError ? error.message : `The marketplace could not be read: ${error.message}` };
    }
    catalogs.set(market.name, result);
    return result;
  }
  async function manifestVersion(dir) {
    for (const rel of ['.veyo-plugin/plugin.json', '.claude-plugin/plugin.json']) {
      const file = path.join(dir, ...rel.split('/'));
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > 256 * 1024) return null;
        const version = JSON.parse(await fs.readFile(file, 'utf8')).version;
        return typeof version === 'string' && SEMVER.test(version) ? version : null;
      } catch {
        /* Try the next manifest name. */
      }
    }
    return null;
  }
  /** The newest version and commit a marketplace entry offers, for update checks. */
  async function latest(market, entry) {
    if (!entry.source) return null;
    let version = entry.version;
    if (!version && entry.source.type === 'relative')
      version = await manifestVersion(path.join(marketplaceRoot(market), ...entry.source.path.split('/')));
    return { version, sha: entry.source.sha || (entry.source.type === 'relative' ? market.sha : null) || null };
  }
  function describeSource(source) {
    if (source.type === 'relative') return source.path;
    return [source.url, source.path && `→ ${source.path}`, source.ref && `@ ${source.ref}`, source.sha && `(${source.sha.slice(0, 12)})`].filter(Boolean).join(' ');
  }
  async function cloneInto({ url, ref, sha, path: subdir }, folder) {
    const checkout = `${folder}-git`;
    try {
      const head = await git.clone(url, checkout, { ref, sha });
      let from = checkout;
      if (subdir) {
        const base = await fs.realpath(checkout);
        const real = await fs.realpath(path.join(base, ...subdir.split('/'))).catch(() => null);
        if (!real || !inside(base, real)) fail(`The folder "${subdir}" was not found in the repository.`);
        from = real;
      }
      await copyTree(from, folder, { exclude: ['.git'] });
      return head;
    } finally {
      await fs.rm(checkout, { recursive: true, force: true });
    }
  }
  async function fromMarketplace(request, folder) {
    const market = registry.get().marketplaces.find((item) => item.name === request.marketplace);
    if (!market) fail('That marketplace is no longer added.');
    const catalog = await loadCatalog(market);
    if (catalog.error) fail(catalog.error);
    const entry = catalog.value.plugins.find((item) => item.name === request.name);
    if (!entry) fail(`"${request.name}" is not listed in ${market.name}.`);
    if (entry.error) fail(entry.error);
    const base = { marketplace: market.name, source: { kind: 'marketplace', marketplace: market.name, name: entry.name }, expectedName: entry.name };
    if (entry.source.type === 'relative') {
      const rootDir = await fs.realpath(marketplaceRoot(market));
      const real = await fs.realpath(path.join(rootDir, ...entry.source.path.split('/'))).catch(() => null);
      if (!real) fail(`The plugin folder "${entry.source.path}" is missing from the marketplace.`);
      if (!inside(rootDir, real)) fail('The plugin folder is outside the marketplace.');
      await copyTree(real, folder, { exclude: ['.git'] });
      return { ...base, sha: market.sha, display: `${sourceDisplay(market.source)} → ${entry.source.path}` };
    }
    const sha = await cloneInto(entry.source, folder);
    return { ...base, sha, display: describeSource(entry.source) };
  }
  async function fromGit(request, folder) {
    const url = git.validateURL(request.url);
    const sha = await cloneInto({ url, ref: request.ref || undefined }, folder);
    return { marketplace: 'git', source: { kind: 'git', url, ...(request.ref && { ref: request.ref }) }, sha, display: request.ref ? `${url} @ ${request.ref}` : url };
  }

  /*
   * Adds a marketplace the person typed or picked (Git ones are cloned shallowly),
   * or, with `builtin`, Veyo's own public catalog. A built-in add adopts a
   * marketplace of the same name the person already added.
   */
  async function addMarketplace(input, { builtin = false } = {}) {
    await init();
    const parsed = parseMarketplaceInput(input, { allowFile: git.allowFile });
    const now = new Date().toISOString();
    let added;
    const ensureNewMarketplace = (name) => {
      if (!registry.get().marketplaces.some((market) => market.name === name)) return;
      if (builtin) throw Object.assign(new PluginError('exists'), { adopt: name });
      fail(`A marketplace named "${name}" is already added.`);
    };
    try {
      if (parsed.kind === 'local') {
        let real;
        try {
          real = await fs.realpath(parsed.path);
          if (!(await fs.stat(real)).isDirectory()) throw new Error();
        } catch {
          fail('That marketplace folder was not found.');
        }
        const value = await readIndex(real);
        ensureNewMarketplace(value.name);
        added = { name: value.name, source: { kind: 'local', path: real }, addedAt: now, lastUpdated: now };
      } else {
        if (!(await gitAvailable())) fail('Git is not installed or not on PATH. Install Git to add Git marketplaces.');
        const temp = path.join(stagingDir, `marketplace-${crypto.randomUUID()}`);
        try {
          const sha = await git.clone(parsed.url, temp, {});
          const value = await readIndex(temp);
          ensureNewMarketplace(value.name);
          const target = path.join(marketplacesDir, value.name);
          await fs.mkdir(marketplacesDir, { recursive: true });
          await fs.rm(target, { recursive: true, force: true });
          await fs.rename(temp, target);
          added = { name: value.name, source: { kind: 'git', url: parsed.url }, addedAt: now, lastUpdated: now, sha };
        } finally {
          await fs.rm(temp, { recursive: true, force: true });
        }
      }
    } catch (error) {
      if (!error.adopt) throw error;
      await registry.save((value) => {
        const item = value.marketplaces.find((market) => market.name === error.adopt);
        if (item) item.builtin = true;
      });
      onChange();
      return registry.get().marketplaces.find((market) => market.name === error.adopt);
    }
    if (builtin) added.builtin = true;
    await registry.save((value) => {
      value.marketplaces.push(added);
    });
    catalogs.delete(added.name);
    onChange();
    return added;
  }

  // Veyo's built-in public catalog --------------------------------------------
  // Added the first time plugins are browsed, never at start-up; refreshed in the
  // background when a day old. Refreshing never installs or updates a plugin.
  const STALE = 24 * 60 * 60 * 1000;
  let publicReady = null;
  let publicError = '';
  function ensurePublic() {
    if (!publicCatalog) return Promise.resolve();
    publicReady ||= (async () => {
      const builtin = registry.get().marketplaces.find((market) => market.builtin);
      if (builtin) {
        if (Date.now() - Date.parse(builtin.lastUpdated || builtin.addedAt) > STALE)
          refreshMarketplace(builtin.name).then(
            () => (publicError = ''),
            (error) => (publicError = error.message),
          );
        return;
      }
      try {
        await addMarketplace(publicCatalog, { builtin: true });
        publicError = '';
      } catch (error) {
        publicError = error.message;
        publicReady = null;
      }
    })();
    return publicReady;
  }
  /** Tries the public catalog again (after being offline, say). */
  async function refreshPublic() {
    await init();
    const builtin = registry.get().marketplaces.find((market) => market.builtin);
    if (builtin) {
      try {
        await refreshMarketplace(builtin.name);
        publicError = '';
      } catch (error) {
        publicError = error.message;
        throw error;
      }
      return;
    }
    publicReady = null;
    await ensurePublic();
    if (publicError) fail(publicError);
  }

  const iconCache = new Map();
  const ICON_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
  /*
   * A listing's icon as a data: URL. The file must be a regular file inside the
   * marketplace, at most 256 KB. SVGs are shown through <img>, which runs no script.
   */
  async function iconData(market, rel) {
    if (!rel) return null;
    const key = `${market.name}|${market.lastUpdated || market.addedAt}|${market.sha || ''}|${rel}`;
    if (iconCache.has(key)) return iconCache.get(key);
    let result = null;
    try {
      const base = await fs.realpath(marketplaceRoot(market));
      const file = path.join(base, ...rel.split('/'));
      const stat = await fs.lstat(file);
      const type = ICON_TYPES[path.extname(file).toLowerCase()];
      if (type && stat.isFile() && stat.size <= 256 * 1024 && inside(base, await fs.realpath(file)))
        result = `data:${type};base64,${(await fs.readFile(file)).toString('base64')}`;
    } catch {
      /* A missing or unreadable icon falls back to a monogram. */
    }
    if (iconCache.size > 500) iconCache.clear();
    iconCache.set(key, result);
    return result;
  }
  async function refreshMarketplace(name) {
    await init();
    const market = registry.get().marketplaces.find((item) => item.name === name);
    if (!market) fail('That marketplace is no longer added.');
    let sha = market.sha;
    if (market.source.kind === 'local') {
      const value = await readIndex(market.source.path);
      if (value.name !== name) fail(`The marketplace now calls itself "${value.name}". Remove it and add it again.`);
    } else {
      if (!(await gitAvailable())) fail('Git is not installed or not on PATH.');
      const temp = path.join(stagingDir, `marketplace-${crypto.randomUUID()}`);
      const target = path.join(marketplacesDir, name);
      const old = `${target}.old-${crypto.randomBytes(4).toString('hex')}`;
      try {
        sha = await git.clone(market.source.url, temp, { ref: market.source.ref });
        const value = await readIndex(temp);
        if (value.name !== name) fail(`The marketplace now calls itself "${value.name}". Remove it and add it again.`);
        await fs.rename(target, old).catch(() => {});
        await fs.rename(temp, target);
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
        await fs.rm(old, { recursive: true, force: true });
      }
    }
    await registry.save((value) => {
      const item = value.marketplaces.find((entry) => entry.name === name);
      if (!item) return;
      item.lastUpdated = new Date().toISOString();
      if (sha) item.sha = sha;
    });
    catalogs.delete(name);
    onChange();
  }
  /** Installed plugins from the marketplace stay installed; only the catalog goes. */
  async function removeMarketplace(name) {
    await init();
    const market = registry.get().marketplaces.find((item) => item.name === name);
    if (!market) fail('That marketplace is no longer added.');
    if (market.builtin) fail('The Veyo catalog is built in and cannot be removed.');
    await registry.save((value) => {
      value.marketplaces = value.marketplaces.filter((item) => item.name !== name);
    });
    catalogs.delete(name);
    if (market.source.kind === 'git') await fs.rm(path.join(marketplacesDir, name), { recursive: true, force: true });
    onChange();
  }
  /** Updates available for installed plugins, by registry key. */
  async function updates() {
    const result = new Map();
    for (const market of registry.get().marketplaces) {
      const installed = registry.get().plugins.filter((entry) => entry.marketplace === market.name);
      if (!installed.length) continue;
      const catalog = await loadCatalog(market);
      for (const entry of installed) {
        const listed = catalog.value?.plugins.find((item) => item.name === entry.name && !item.error);
        if (listed && isUpdateAvailable(entry, await latest(market, listed))) result.set(entryKey(entry), true);
      }
    }
    return result;
  }
  async function catalog() {
    await init();
    await ensurePublic();
    const installed = registry.get().plugins;
    const marketplaces = [];
    const plugins = [];
    for (const market of registry.get().marketplaces) {
      const result = await loadCatalog(market);
      marketplaces.push({
        ...market,
        description: result.value?.description || '',
        owner: result.value?.owner || '',
        count: result.value?.plugins.length ?? 0,
        sections: result.value?.sections ?? [],
        ...(result.error && { error: result.error }),
      });
      if (!result.value) continue;
      for (const entry of result.value.plugins) {
        const id = `${entry.name}@${market.name}`;
        const mine = installed.filter((item) => item.id === id);
        const newest = mine.length && !entry.error ? await latest(market, entry) : null;
        plugins.push({
          id,
          marketplace: market.name,
          name: entry.name,
          description: entry.description,
          version: entry.version,
          category: entry.category,
          tags: entry.tags,
          author: entry.author,
          homepage: entry.homepage,
          source: entry.source ? describeSource(entry.source) : '',
          sourceType: entry.source?.type ?? null,
          displayName: entry.displayName || entry.name,
          tagline: entry.tagline,
          provider: entry.provider,
          setup: entry.setup,
          icon: await iconData(market, entry.icon),
          iconDark: await iconData(market, entry.iconDark),
          error: entry.error,
          installed: mine.map((item) => ({ key: entryKey(item), scope: item.scope, projectId: item.projectId, version: item.version })),
          updateAvailable: mine.some((item) => isUpdateAvailable(item, newest)),
        });
      }
    }
    return {
      marketplaces,
      plugins,
      gitAvailable: await gitAvailable(),
      publicName: registry.get().marketplaces.find((market) => market.builtin)?.name ?? null,
      publicError,
    };
  }

  /*
   * Copies or clones a plugin into staging and validates it. The result is
   * everything the consent dialog shows; installing moves exactly these files.
   */
  async function preview(request) {
    await init();
    if (!request || typeof request !== 'object') fail('Choose a plugin to install.');
    if (previews.size >= MAX_PREVIEWS) await discardPreview(previews.keys().next().value);
    const id = crypto.randomUUID();
    const dir = path.join(stagingDir, id);
    const folder = path.join(dir, 'plugin');
    try {
      let origin;
      if (request.kind === 'local') {
        if (!isText(request.path, 4096) || !path.isAbsolute(request.path)) fail('Choose a plugin folder.');
        let real;
        try {
          real = await fs.realpath(request.path);
          if (!(await fs.stat(real)).isDirectory()) throw new Error();
        } catch {
          fail('That plugin folder was not found.');
        }
        // Only a folder that looks like a plugin is copied.
        const hasManifest = await Promise.all(
          ['.veyo-plugin', '.claude-plugin'].map((dir) => fs.lstat(path.join(real, dir, 'plugin.json')).then((stat) => stat.isFile(), () => false)),
        );
        if (!hasManifest.some(Boolean)) fail('No plugin manifest found. Expected .veyo-plugin/plugin.json (or .claude-plugin/plugin.json).');
        await copyTree(real, folder, { exclude: ['.git'] });
        origin = { marketplace: 'local', source: { kind: 'local', path: real }, display: real };
      } else if (request.kind === 'marketplace' || request.kind === 'git') {
        origin = request.kind === 'marketplace' ? await fromMarketplace(request, folder) : await fromGit(request, folder);
      } else fail('Unknown plugin source.');
      const fallbackVersion = origin.sha ? origin.sha.slice(0, 12) : `local-${(await hashTree(folder)).slice(0, 12)}`;
      const plugin = await loadPlugin(folder, { appVersion, fallbackVersion, listedName: origin.expectedName });
      const pluginId = `${plugin.name}@${origin.marketplace}`;
      const installed = registry.get().plugins.filter((entry) => entry.id === pluginId);
      const conflict = conflictingInstall(registry.get().plugins, plugin.name, origin.marketplace);
      const previous = installed[0] && loaded.get(installed[0].installPath)?.plugin;
      const timer = setTimeout(() => discardPreview(id).catch(() => {}), PREVIEW_TTL);
      timer.unref?.();
      previews.set(id, { dir, folder, plugin, origin, timer });
      return {
        previewId: id,
        id: pluginId,
        marketplace: origin.marketplace,
        source: origin.display,
        sha: origin.sha || null,
        plugin: { ...summary(plugin), contributes: plugin.contributes, readme: plugin.readme },
        installed: installed.map((entry) => ({ key: entryKey(entry), scope: entry.scope, projectId: entry.projectId, version: entry.version })),
        conflict: conflict ? `Another plugin named "${plugin.name}" is installed from ${conflict.marketplace}. Uninstall it first.` : null,
        update: previous ? diffPlugins(previous, plugin) : null,
        // Whether installing makes anything runnable: commands, agents or MCP servers.
        risk: plugin.contributes.commands.length || plugin.contributes.agents.length || plugin.contributes.mcpServers.length ? 'runs' : 'none',
      };
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async function install(previewId, scope, projectId) {
    await init();
    const preview = previews.get(previewId);
    if (!preview) fail('This preview has expired. Open the plugin again to review it.');
    if (scope !== 'user' && scope !== 'project') fail('Choose where to install the plugin.');
    if (scope === 'project' && !isText(projectId, 200)) fail('Open a project to install a plugin for it.');
    const { plugin, origin, folder } = preview;
    if (!plugin.compatible) fail(`This plugin needs Veyo ${plugin.minAppVersion} or later.`);
    const conflict = conflictingInstall(registry.get().plugins, plugin.name, origin.marketplace);
    if (conflict) fail(`Another plugin named "${plugin.name}" is installed from ${conflict.marketplace}. Uninstall it first.`);
    const base = path.join(cacheDir, safeSegment(origin.marketplace), safeSegment(plugin.name));
    await fs.mkdir(base, { recursive: true });
    let target = path.join(base, safeSegment(plugin.version));
    if (registry.get().plugins.some((entry) => entry.installPath === target)) target += `-${crypto.randomBytes(4).toString('hex')}`;
    else await fs.rm(target, { recursive: true, force: true });
    await fs.rename(folder, target);
    const now = new Date().toISOString();
    const entry = {
      id: `${plugin.name}@${origin.marketplace}`,
      name: plugin.name,
      marketplace: origin.marketplace,
      scope,
      ...(scope === 'project' && { projectId }),
      version: plugin.version,
      ...(origin.sha && { sha: origin.sha }),
      source: origin.source,
      installPath: target,
      installedAt: now,
      lastUpdated: now,
      enabled: true,
    };
    let replaced;
    try {
      await registry.save((value) => {
        const index = value.plugins.findIndex((item) => entryKey(item) === entryKey(entry));
        if (index >= 0) {
          replaced = value.plugins[index];
          entry.installedAt = replaced.installedAt;
          entry.enabled = replaced.enabled;
          if (replaced.connections) entry.connections = replaced.connections;
          value.plugins.splice(index, 1, entry);
        } else value.plugins.push(entry);
      });
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true });
      throw error;
    }
    loaded.set(target, { plugin });
    await discardPreview(previewId);
    if (replaced && replaced.installPath !== target) await removeUnused(replaced.installPath);
    onChange();
    return { key: entryKey(entry), id: entry.id, version: entry.version };
  }

  async function setEnabled(key, enabled) {
    await init();
    if (typeof enabled !== 'boolean') fail('Invalid plugin state.');
    find(key);
    await registry.save((value) => {
      const item = value.plugins.find((entry) => entryKey(entry) === key);
      if (item) item.enabled = enabled;
    });
    onChange();
  }

  async function uninstall(key) {
    await init();
    const entry = find(key);
    await registry.save((value) => {
      value.plugins = value.plugins.filter((item) => entryKey(item) !== key);
    });
    await removeUnused(entry.installPath);
    onChange();
  }

  /** Project installs belong to the project; removing it from Veyo removes them. */
  async function forgetProject(projectId) {
    await init();
    const gone = registry.get().plugins.filter((entry) => entry.scope === 'project' && entry.projectId === projectId);
    if (!gone.length) return;
    await registry.save((value) => {
      value.plugins = value.plugins.filter((entry) => !gone.some((item) => entryKey(item) === entryKey(entry)));
    });
    for (const entry of gone) await removeUnused(entry.installPath);
    onChange();
  }

  async function state(projectId) {
    await init();
    const active = new Set(activeEntries(registry.get().plugins, projectId || null).map(entryKey));
    const available = await updates().catch(() => new Map());
    return {
      plugins: registry.get().plugins.map((entry) => {
        const result = loaded.get(entry.installPath) || { error: 'Not loaded.' };
        return {
          key: entryKey(entry),
          id: entry.id,
          name: entry.name,
          marketplace: entry.marketplace,
          scope: entry.scope,
          projectId: entry.projectId,
          version: entry.version,
          sha: entry.sha,
          source: entry.source,
          installedAt: entry.installedAt,
          lastUpdated: entry.lastUpdated,
          enabled: entry.enabled,
          connections: entry.connections || [],
          updateAvailable: available.has(entryKey(entry)),
          active: active.has(entryKey(entry)) && !!result.plugin?.compatible,
          error: result.error,
          ...(result.plugin && { plugin: summary(result.plugin) }),
        };
      }),
      marketplaces: registry.get().marketplaces,
    };
  }

  /** The plugins that currently apply, fully loaded and compatible. */
  async function activePlugins(projectId) {
    await init();
    return activeEntries(registry.get().plugins, projectId || null)
      .map((entry) => ({ entry, plugin: loaded.get(entry.installPath)?.plugin }))
      .filter(({ plugin }) => plugin && plugin.compatible);
  }

  async function contributions(projectId) {
    const result = { commands: [], agents: [], prompts: [], themes: [] };
    for (const { entry, plugin } of await activePlugins(projectId)) {
      const from = { plugin: plugin.name, pluginKey: entryKey(entry) };
      const c = plugin.contributes;
      for (const item of c.commands) result.commands.push({ key: `${plugin.name}:${item.id}`, title: item.title, description: item.description, program: item.run.program, args: item.run.args, ...from });
      for (const item of c.agents) result.agents.push({ key: `${plugin.name}:${item.id}`, label: item.label, mark: item.mark, program: item.program, args: item.args, ...from });
      for (const kind of ['prompts', 'skills'])
        for (const item of c[kind]) result.prompts.push({ key: `${plugin.name}:${kind === 'skills' ? 'skill-' : ''}${item.id}`, kind: kind === 'skills' ? 'skill' : 'prompt', title: item.title, description: item.description, body: item.body, ...from });
      for (const item of c.themes) result.themes.push({ key: `${plugin.name}:${item.id}`, label: item.label, base: item.base, colors: item.colors, ...from });
    }
    return result;
  }

  /** A contribution looked up by its namespaced key, with the folder it runs from. */
  async function resolve(projectId, kind, key) {
    if (!isText(key, 200)) fail('Unknown plugin item.');
    const [name, itemId] = key.split(':');
    if (!NAME.test(name || '') || !itemId) fail('Unknown plugin item.');
    for (const { entry, plugin } of await activePlugins(projectId)) {
      if (plugin.name !== name) continue;
      const item = plugin.contributes[kind].find((value) => value.id === itemId);
      if (item) return { entry, plugin, item, pluginRoot: entry.installPath };
    }
    fail('That plugin item is not available. The plugin may be disabled or removed.');
  }

  /** One MCP server definition of an installed plugin, with the folder it refers to. */
  async function mcpServer(key, name) {
    await init();
    const entry = find(key);
    if (!entry.enabled) fail('Enable the plugin first.');
    const plugin = loaded.get(entry.installPath)?.plugin;
    if (!plugin) fail('This plugin could not be loaded.');
    const server = plugin.contributes.mcpServers.find((item) => item.name === name);
    if (!server) fail('That MCP server is not part of this plugin.');
    return { server, plugin: plugin.name, scope: entry.scope, installPath: entry.installPath };
  }

  /*
   * An MCP server of a plugin still being reviewed, so its exact add command can
   * be shown before installing. The install folder does not exist yet, so a
   * placeholder stands in for it; running always uses the installed copy.
   */
  async function previewMcpServer(previewId, name, scope) {
    await init();
    const preview = previews.get(previewId);
    if (!preview) fail('This preview has expired. Open the plugin again to review it.');
    const server = preview.plugin.contributes.mcpServers.find((item) => item.name === name);
    if (!server) fail('That MCP server is not part of this plugin.');
    return { server, plugin: preview.plugin.name, scope: scope === 'project' ? 'project' : 'user', installPath: '<plugin folder>' };
  }

  /** Records an MCP server a coding CLI accepted (its add command exited with 0). */
  async function recordConnection(key, connection) {
    await init();
    find(key);
    await registry.save((value) => {
      const item = value.plugins.find((entry) => entryKey(entry) === key);
      if (!item) return;
      const others = (item.connections || []).filter((c) => !(c.cli === connection.cli && c.name === connection.name));
      item.connections = [...others, { ...connection, at: new Date().toISOString() }];
    });
    onChange();
  }
  async function forgetConnection(key, cli, name) {
    await init();
    await registry.save((value) => {
      const item = value.plugins.find((entry) => entryKey(entry) === key);
      if (item?.connections) item.connections = item.connections.filter((c) => !(c.cli === cli && c.name === name));
    });
    onChange();
  }
  /** The recorded connections of an install, for removing them from the CLIs. */
  async function connectionsOf(key) {
    await init();
    return find(key).connections || [];
  }

  async function details(key) {
    await init();
    const entry = find(key);
    const result = loaded.get(entry.installPath);
    if (!result?.plugin) return { key, error: result?.error || 'Not loaded.' };
    return { key, plugin: { ...summary(result.plugin), contributes: result.plugin.contributes, readme: result.plugin.readme } };
  }

  return {
    init,
    preview,
    cancelPreview: discardPreview,
    install,
    setEnabled,
    uninstall,
    forgetProject,
    state,
    contributions,
    resolve,
    details,
    mcpServer,
    recordConnection,
    previewMcpServer,
    forgetConnection,
    connectionsOf,
    refreshPublic,
    registry,
    paths: { root, cacheDir, stagingDir, marketplacesDir },
    addMarketplace,
    refreshMarketplace,
    removeMarketplace,
    catalog,
    gitAvailable,
  };
}

module.exports = { createPluginService, diffPlugins };
