const path = require('node:path');
const { PluginError } = require('./files.cjs');
const { NAME, SEMVER, compareVersions, relPath } = require('./manifest.cjs');
const { validateGitURL, validateRef } = require('./git.cjs');
const { RESERVED } = require('./registry.cjs');

const MARKETPLACE_FILES = ['.veyo-plugin/marketplace.json', '.claude-plugin/marketplace.json'];
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const SHA = /^[0-9a-f]{40}$/;
const GITHUB_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function fail(message) {
  throw new PluginError(message);
}
const shortText = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const SETUP = ['none', 'sign-in', 'token', 'oauth-client'];
const ICON = /\.(svg|png|webp)$/i;

/** A listing's one-line summary: its tagline, else the first sentence of the description. */
function taglineOf(item) {
  const own = shortText(item?.tagline, 80).trim();
  if (own) return own;
  const description = shortText(item?.description, 1000).trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(description)?.[1] || description;
  return sentence.length > 80 ? `${sentence.slice(0, 77).trimEnd()}…` : sentence;
}
/** An icon path inside the marketplace; an invalid one is dropped, not fatal. */
function iconPath(value) {
  if (typeof value !== 'string' || !ICON.test(value)) return null;
  try {
    return relPath(value, 'icon');
  } catch {
    return null;
  }
}
/** Curated rows such as Popular; names that are not listed (or invalid) are skipped. */
function sectionsOf(value, names) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const section of value.slice(0, 10)) {
    if (!section || typeof section !== 'object' || typeof section.id !== 'string' || !NAME.test(section.id)) continue;
    const title = shortText(section.title, 60).trim();
    const plugins = Array.isArray(section.plugins)
      ? [...new Set(section.plugins.filter((name) => typeof name === 'string' && names.has(name)))].slice(0, 50)
      : [];
    if (title && plugins.length) result.push({ id: section.id, title, plugins });
  }
  return result;
}

/*
 * What a person typed into "Add marketplace": a Git address, GitHub
 * "owner/repo", or an absolute folder path.
 */
function parseMarketplaceInput(input, { allowFile = false } = {}) {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value || value.length > 2048) fail('Enter a Git address, owner/repo, or a folder path.');
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return { kind: 'local', path: value };
  if (GITHUB_REPO.test(value) && !value.includes('..')) return { kind: 'git', url: `https://github.com/${value.replace(/\.git$/, '')}.git` };
  return { kind: 'git', url: validateGitURL(value, { allowFile }) };
}

function source(raw, pluginRoot) {
  if (typeof raw === 'string') {
    const rel = relPath(pluginRoot && !raw.startsWith('./') && !raw.startsWith('../') ? `${pluginRoot}/${raw}` : raw, 'plugin source');
    return { type: 'relative', path: rel };
  }
  if (!raw || typeof raw !== 'object') fail('The plugin source is missing.');
  const pin = () => {
    if (raw.sha !== undefined && !SHA.test(raw.sha)) fail('The pinned sha must be a full 40-character commit sha.');
    return { ...(raw.ref !== undefined && { ref: validateRef(raw.ref) }), ...(raw.sha && { sha: raw.sha }) };
  };
  switch (raw.source) {
    case 'github':
      if (typeof raw.repo !== 'string' || !GITHUB_REPO.test(raw.repo) || raw.repo.includes('..')) fail('The GitHub repository must look like owner/repo.');
      return { type: 'git', url: `https://github.com/${raw.repo}.git`, ...pin() };
    case 'url':
    case 'git':
      return { type: 'git', url: validateGitURL(raw.url), ...pin() };
    case 'git-subdir':
      return { type: 'git', url: validateGitURL(raw.url), path: relPath(raw.path, 'plugin source'), ...pin() };
    case 'npm':
      fail('npm plugin sources are not supported by Veyo.');
    default:
      fail(`The plugin source type "${String(raw.source).slice(0, 40)}" is not supported.`);
  }
}

/*
 * A marketplace index. Entries that fail validation stay in the list with an
 * error, so one bad entry never hides the rest of the catalog.
 */
function parseMarketplace(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('The marketplace index must be a JSON object.');
  if (typeof raw.name !== 'string' || !NAME.test(raw.name) || raw.name.length > 64)
    fail('The marketplace name must be lowercase letters, digits and single hyphens.');
  if (RESERVED.includes(raw.name)) fail(`"${raw.name}" is reserved and cannot name a marketplace.`);
  if (!Array.isArray(raw.plugins)) fail('The marketplace index needs a plugins list.');
  if (raw.plugins.length > MAX_ENTRIES) fail(`A marketplace can list at most ${MAX_ENTRIES} plugins.`);
  const pluginRoot = typeof raw.metadata?.pluginRoot === 'string' ? raw.metadata.pluginRoot.replace(/^\.\//, '').replace(/\/$/, '') : '';
  const seen = new Set();
  const plugins = raw.plugins.map((item, index) => {
    const name = typeof item?.name === 'string' ? item.name.slice(0, 64) : `entry-${index + 1}`;
    const entry = {
      name,
      description: shortText(item?.description, 1000),
      version: typeof item?.version === 'string' && SEMVER.test(item.version) ? item.version : null,
      category: shortText(item?.category, 40).toLowerCase(),
      tags: Array.isArray(item?.tags) ? item.tags.filter((tag) => typeof tag === 'string').slice(0, 10).map((tag) => tag.slice(0, 40)) : [],
      author: shortText(typeof item?.author === 'string' ? item.author : item?.author?.name, 200),
      homepage: typeof item?.homepage === 'string' && /^https?:\/\//i.test(item.homepage) ? item.homepage.slice(0, 2048) : '',
      displayName: shortText(item?.displayName, 60).trim(),
      tagline: taglineOf(item),
      icon: iconPath(item?.icon),
      iconDark: iconPath(item?.iconDark),
      provider: shortText(item?.provider, 60).trim(),
      setup: SETUP.includes(item?.setup) ? item.setup : 'none',
      source: null,
      error: null,
    };
    try {
      if (!item || typeof item !== 'object') fail('The entry is not an object.');
      if (!NAME.test(name)) fail('The plugin name must be lowercase letters, digits and single hyphens.');
      if (seen.has(name)) fail(`"${name}" is listed more than once.`);
      seen.add(name);
      entry.source = source(item.source, pluginRoot);
    } catch (error) {
      entry.error = error instanceof PluginError ? error.message : 'The entry is invalid.';
    }
    return entry;
  });
  return {
    name: raw.name,
    description: shortText(raw.description, 1000),
    owner: shortText(typeof raw.owner === 'string' ? raw.owner : raw.owner?.name, 200),
    plugins,
    sections: sectionsOf(raw.sections, new Set(plugins.filter((plugin) => !plugin.error).map((plugin) => plugin.name))),
  };
}

/*
 * Whether a marketplace offers something newer than what is installed: a higher
 * version when both have one, otherwise a different pinned commit.
 */
function isUpdateAvailable(installed, latest) {
  if (!latest) return false;
  if (latest.version && SEMVER.test(installed.version)) return compareVersions(latest.version, installed.version) > 0;
  if (latest.sha && installed.sha) return latest.sha !== installed.sha;
  if (latest.version && latest.version !== installed.version) return true;
  return false;
}

module.exports = { MARKETPLACE_FILES, MAX_BYTES, isUpdateAvailable, parseMarketplace, parseMarketplaceInput };
