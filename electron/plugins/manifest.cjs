const fs = require('node:fs/promises');
const path = require('node:path');
const { inside } = require('../core.cjs');
const { LIMITS, PluginError, scanTree } = require('./files.cjs');

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PROGRAM = /^[A-Za-z0-9._-]{1,128}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
// Midnight and Plum were removed from the app; themes built on them now use graphite.
const THEME_BASES = ['graphite', 'midnight', 'plum', 'light'];
const THEME_COLORS = ['chrome', 'stage', 'well', 'raised', 'accent', 'foreground', 'muted', 'selection', 'keyword', 'string'];
const MANIFESTS = [
  { file: '.veyo-plugin/plugin.json', format: 'veyo' },
  { file: '.claude-plugin/plugin.json', format: 'claude' },
];
// Pieces other tools understand that Veyo deliberately leaves alone in v1.
const CLAUDE_UNSUPPORTED = { hooks: 'hooks', agents: 'agents', outputStyles: 'output-styles', lspServers: null };
/*
 * Arguments that change a coding agent's approval or sandbox behaviour. A plugin
 * preset may pick a model or add a prompt, never decide how much an agent may do
 * without asking.
 */
const BYPASS_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--allow-dangerously-skip-permissions',
  '--permission-mode',
  '--permission-prompt-tool',
  '--yolo',
  '--full-auto',
  '--sandbox',
  '-s',
  '--ask-for-approval',
  '-a',
  '--approval-mode',
  '--allow-all-tools',
  '--allow-all',
  '--allowedtools',
  '--allowed-tools',
  '--trust',
  '--auto-approve',
  '--force',
  '-y',
]);
const BYPASS_PATTERN = /bypass|yolo|skip-?permission|auto-?approv|dangerous|full-?access/i;

function fail(message) {
  throw new PluginError(message);
}
function compareVersions(a, b) {
  const pa = SEMVER.exec(a), pb = SEMVER.exec(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  return pa[4].localeCompare(pb[4], undefined, { numeric: true });
}
function text(value, label, max, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(`The manifest needs a ${label}.`);
    return '';
  }
  if (typeof value !== 'string' || value.length > max) fail(`The ${label} must be text of at most ${max} characters.`);
  return value;
}
function webURL(value, label) {
  const result = text(value, label, 2048);
  if (!result) return '';
  try {
    const url = new URL(result);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch {
    fail(`The ${label} must be an http(s) web address.`);
  }
  return result;
}
function id(value, label) {
  if (typeof value !== 'string' || value.length > 64 || !NAME.test(value))
    fail(`${label} must be lowercase letters, digits and single hyphens (for example "run-tests"), at most 64 characters.`);
  return value;
}
/** A manifest path: relative, inside the plugin, posix separators. */
function relPath(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) fail(`The ${label} path is missing or too long.`);
  const posix = value.replaceAll('\\', '/');
  if (path.isAbsolute(value) || path.posix.isAbsolute(posix) || /^[a-zA-Z]:/.test(posix) || posix.startsWith('//'))
    fail(`The ${label} path "${value}" must be relative to the plugin folder.`);
  const parts = posix.replace(/^\.\//, '').replace(/\/$/, '').split('/');
  if (parts.some((part) => !part || part === '..' || part.includes(':') || /[\x00-\x1f]/.test(part)))
    fail(`The ${label} path "${value}" must stay inside the plugin folder.`);
  return parts.filter((part) => part !== '.').join('/');
}
async function resolveInside(root, rel, label) {
  const target = path.join(root, ...rel.split('/'));
  if (!inside(root, target)) fail(`The ${label} path must stay inside the plugin folder.`);
  let real;
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) fail(`The ${label} path "${rel}" is a link. Plugins cannot contain links.`);
    real = await fs.realpath(target);
  } catch (error) {
    if (error instanceof PluginError) throw error;
    fail(`The ${label} path "${rel}" was not found in the plugin.`);
  }
  if (!inside(root, real)) fail(`The ${label} path "${rel}" leads outside the plugin through a link.`);
  return real;
}
async function readSmall(file, label, max = LIMITS.fileBytes) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) fail(`The ${label} is not a file.`);
  if (stat.size > max) fail(`The ${label} is too large (limit ${Math.round(max / 1024)} KB).`);
  return fs.readFile(file, 'utf8');
}
function parseJSON(source, label) {
  try {
    return JSON.parse(source.replace(/^﻿/, ''));
  } catch (error) {
    fail(`The ${label} is not valid JSON: ${error.message}`);
  }
}
function capped(list, label) {
  if (list.length > LIMITS.contributions) fail(`A plugin can contribute at most ${LIMITS.contributions} ${label}.`);
  return list;
}

/*
 * Checks a command or agent argument list. `batch` applies cmd.exe's extra
 * restrictions; `agent` refuses flags that would change approval settings.
 */
function checkArgs(args, { batch = false, agent = false } = {}) {
  if (args === undefined) return [];
  if (!Array.isArray(args) || args.length > 64) fail('args must be a list of at most 64 strings.');
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length > 2000) fail('Each argument must be text of at most 2,000 characters.');
    if (/[\x00-\x1f\x7f]/.test(arg)) fail(`The argument "${arg.slice(0, 40)}" contains a control character.`);
    if (arg.includes('"')) fail(`The argument "${arg.slice(0, 40)}" contains a double quote, which cannot be passed safely.`);
    if (batch && /[%!^&|<>]/.test(arg))
      fail(`The argument "${arg.slice(0, 40)}" contains a character (% ! ^ & | < >) that cmd scripts cannot receive safely.`);
    if (agent) {
      const flag = arg.split('=')[0].toLowerCase();
      if (BYPASS_FLAGS.has(flag) || BYPASS_PATTERN.test(arg))
        fail(`Agent presets cannot change approval or sandbox settings ("${arg.slice(0, 60)}").`);
    }
  }
  return [...args];
}
const isBatch = (program) => /\.(cmd|bat)$/i.test(program);

async function program(root, value, label) {
  if (typeof value !== 'string') fail(`${label} needs a program.`);
  if (value.startsWith('${pluginRoot}/')) {
    const rel = relPath(value.slice('${pluginRoot}/'.length), `${label} program`);
    const real = await resolveInside(root, rel, `${label} program`);
    if (!(await fs.stat(real)).isFile()) fail(`${label} program "${rel}" is not a file.`);
    return value;
  }
  if (!PROGRAM.test(value) || value === '.' || value === '..')
    fail(`${label} program "${value.slice(0, 80)}" must be a command name found on PATH or \${pluginRoot}/<file>.`);
  return value;
}
async function commands(root, list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) fail('contributes.commands must be a list.');
  capped(list, 'commands');
  const seen = new Set();
  const result = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') fail('Each command must be an object.');
    const commandId = id(item.id, 'A command id');
    if (seen.has(commandId)) fail(`The command id "${commandId}" is used twice.`);
    seen.add(commandId);
    const label = `Command "${commandId}"`;
    if (!item.run || typeof item.run !== 'object') fail(`${label} needs a run section.`);
    const prog = await program(root, item.run.program, label);
    result.push({
      id: commandId,
      title: text(item.title, `${label} title`, 120, true),
      description: text(item.description, `${label} description`, 500),
      run: { program: prog, args: checkArgs(item.run.args, { batch: isBatch(prog) }) },
    });
  }
  return result;
}
async function agents(root, list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) fail('contributes.agents must be a list.');
  capped(list, 'agent presets');
  const seen = new Set();
  const result = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') fail('Each agent preset must be an object.');
    const agentId = id(item.id, 'An agent preset id');
    if (seen.has(agentId)) fail(`The agent preset id "${agentId}" is used twice.`);
    seen.add(agentId);
    const label = `Agent preset "${agentId}"`;
    const prog = await program(root, item.program, label);
    const mark = text(item.mark, `${label} mark`, 2);
    result.push({
      id: agentId,
      label: text(item.label, `${label} label`, 60, true),
      program: prog,
      args: checkArgs(item.args, { batch: isBatch(prog), agent: true }),
      mark: mark || '◆',
    });
  }
  return result;
}
/** Minimal YAML-style frontmatter: `key: value` lines only. Values are data, never code. */
function frontmatter(source) {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { meta: {}, body: source };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair) meta[pair[1]] = pair[2].replace(/^(['"])(.*)\1$/, '$2').slice(0, 500);
  }
  return { meta, body: source.slice(match[0].length) };
}
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}
async function promptFiles(root, dirs) {
  const result = [];
  for (const dir of dirs) {
    const real = await resolveInside(root, relPath(dir, 'prompts'), 'prompts');
    const entries = (await fs.stat(real)).isDirectory()
      ? (await fs.readdir(real, { withFileTypes: true })).filter((e) => e.isFile() && /\.md$/i.test(e.name)).map((e) => e.name).sort()
      : [path.basename(real)];
    for (const name of entries) {
      const file = (await fs.stat(real)).isDirectory() ? path.join(real, name) : real;
      const { meta, body } = frontmatter(await readSmall(file, `prompt "${name}"`));
      const promptId = slug(name.replace(/\.md$/i, ''));
      if (!promptId) continue;
      result.push({ id: promptId, title: meta.name || promptId, description: meta.description || '', body });
    }
  }
  return capped(result, 'prompts');
}
async function skillFiles(root, dirs) {
  const result = [];
  for (const dir of dirs) {
    const real = await resolveInside(root, relPath(dir, 'skills'), 'skills');
    for (const entry of (await fs.readdir(real, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const file = path.join(real, entry.name, 'SKILL.md');
      try {
        await fs.access(file);
      } catch {
        continue;
      }
      const { meta, body } = frontmatter(await readSmall(file, `skill "${entry.name}"`));
      const skillId = slug(entry.name);
      if (skillId) result.push({ id: skillId, title: meta.name || skillId, description: meta.description || '', body });
    }
  }
  return capped(result, 'skills');
}
function stringMap(value, label) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object of text values.`);
  const entries = Object.entries(value);
  if (entries.length > 50) fail(`${label} has too many entries.`);
  for (const [key, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key) || typeof item !== 'string' || item.length > 2000 || /[\x00-\x1f]/.test(item))
      fail(`${label} has an invalid entry "${key.slice(0, 40)}".`);
  }
  return { ...value };
}
/*
 * How a remote MCP server signs in, so Veyo can offer the right next step:
 * - oauth: browser sign-in through the coding CLI;
 * - env: a token the CLI reads from an environment variable at connect time;
 * - oauth-client: the user's own OAuth client ID; the CLI prompts for the secret.
 * No plugin-supplied patterns are evaluated here.
 */
function mcpAuth(value, label) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object') fail(`${label} auth must be an object.`);
  if (value.type === 'oauth') return { type: 'oauth' };
  if (value.type === 'env') {
    if (typeof value.variable !== 'string' || !/^[A-Z_][A-Z0-9_]{0,63}$/.test(value.variable))
      fail(`${label} auth variable must be an environment variable name such as GITHUB_TOKEN.`);
    return { type: 'env', variable: value.variable, url: webURL(value.url, `${label} auth url`), label: text(value.label, `${label} auth label`, 80) };
  }
  if (value.type === 'oauth-client') {
    if (!Number.isInteger(value.callbackPort) || value.callbackPort < 1024 || value.callbackPort > 65535)
      fail(`${label} auth callbackPort must be a port between 1024 and 65535.`);
    const setupUrl = webURL(value.setupUrl, `${label} auth setupUrl`);
    if (!setupUrl) fail(`${label} auth needs a setupUrl explaining how to create the OAuth client.`);
    return { type: 'oauth-client', callbackPort: value.callbackPort, setupUrl, clientIdHint: text(value.clientIdHint, `${label} auth clientIdHint`, 120) };
  }
  fail(`${label} auth type must be oauth, env or oauth-client.`);
}
function mcpServers(source) {
  const map = source && typeof source === 'object' && source.mcpServers && typeof source.mcpServers === 'object' ? source.mcpServers : source;
  if (!map || typeof map !== 'object' || Array.isArray(map)) fail('MCP servers must be an object keyed by server name.');
  const result = [];
  for (const [name, server] of Object.entries(map)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) fail(`The MCP server name "${name.slice(0, 40)}" is invalid.`);
    if (!server || typeof server !== 'object') fail(`MCP server "${name}" must be an object.`);
    const label = `MCP server "${name}"`;
    if (server.url !== undefined || server.type === 'http' || server.type === 'sse') {
      const type = server.type === 'sse' ? 'sse' : 'http';
      const url = webURL(server.url, `${label} url`);
      if (!url) fail(`${label} needs a url.`);
      result.push({ name, type, url, headers: stringMap(server.headers, `${label} headers`), auth: mcpAuth(server.auth, label) });
    } else {
      if (server.type !== undefined && server.type !== 'stdio') fail(`${label} has an unsupported type.`);
      const command = text(server.command, `${label} command`, 1024, true);
      if (/[\x00-\x1f"]/.test(command)) fail(`${label} command contains characters that cannot be passed safely.`);
      if (server.auth !== undefined) fail(`${label} auth applies only to http and sse servers.`);
      result.push({ name, type: 'stdio', command, args: checkArgs(server.args), env: stringMap(server.env, `${label} env`) });
    }
  }
  return capped(result, 'MCP servers');
}
async function themes(root, list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) fail('contributes.themes must be a list.');
  capped(list, 'themes');
  const result = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') fail('Each theme must be an object.');
    const themeId = id(item.id, 'A theme id');
    const label = text(item.label, `Theme "${themeId}" label`, 40, true);
    const file = await resolveInside(root, relPath(item.path, `theme "${themeId}"`), `theme "${themeId}"`);
    const value = parseJSON(await readSmall(file, `theme "${themeId}"`, 64 * 1024), `theme "${themeId}"`);
    if (!value || !THEME_BASES.includes(value.base)) fail(`Theme "${themeId}" needs a base of ${THEME_BASES.join(', ')}.`);
    const colors = {};
    for (const key of THEME_COLORS) {
      const colour = value.colors?.[key];
      if (typeof colour !== 'string' || !HEX.test(colour)) fail(`Theme "${themeId}" colour "${key}" must be a #rrggbb hex colour.`);
      colors[key] = colour.toLowerCase();
    }
    result.push({ id: themeId, label, base: ['midnight', 'plum'].includes(value.base) ? 'graphite' : value.base, colors });
  }
  return result;
}
function asList(value, label) {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > 20 || list.some((item) => typeof item !== 'string')) fail(`${label} must be a path or a list of paths.`);
  return list;
}
async function exists(root, rel) {
  try {
    await fs.lstat(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

/** Checks the manifest's own fields; contributions are resolved by loadPlugin. */
function validateManifest(raw, format) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('The manifest must be a JSON object.');
  const name = id(raw.name, 'The plugin name');
  let version = raw.version;
  if (format === 'veyo') {
    if (typeof version !== 'string' || !SEMVER.test(version)) fail('The manifest version must be semantic, for example "1.0.0".');
  } else if (typeof version !== 'string' || !SEMVER.test(version)) version = null;
  const author =
    typeof raw.author === 'string'
      ? { name: text(raw.author, 'author', 200) }
      : raw.author && typeof raw.author === 'object'
        ? { name: text(raw.author.name, 'author name', 200), email: text(raw.author.email, 'author email', 200), url: webURL(raw.author.url, 'author url') }
        : null;
  const minAppVersion = text(raw.minAppVersion, 'minAppVersion', 64);
  if (minAppVersion && !SEMVER.test(minAppVersion)) fail('minAppVersion must be semantic, for example "0.1.0".');
  if (raw.contributes !== undefined && (!raw.contributes || typeof raw.contributes !== 'object' || Array.isArray(raw.contributes)))
    fail('contributes must be an object.');
  return {
    name,
    version,
    description: text(raw.description, 'description', 1000),
    author,
    license: text(raw.license, 'license', 100),
    homepage: webURL(raw.homepage ?? (typeof raw.repository === 'string' ? raw.repository : undefined), 'homepage'),
    minAppVersion,
  };
}

/*
 * Reads and validates a plugin folder. Throws a PluginError on anything invalid,
 * so a plugin is either fully loaded or not loaded at all.
 */
/*
 * `listedName` is the name a marketplace lists the plugin under. As in Claude Code,
 * the marketplace's name wins when the manifest calls itself something else.
 */
async function loadPlugin(folder, { appVersion, fallbackVersion = null, listedName }) {
  const root = await fs.realpath(folder);
  await scanTree(root, { exclude: ['.git'] });
  let found;
  for (const candidate of MANIFESTS)
    if (await exists(root, candidate.file)) {
      found = candidate;
      break;
    }
  if (!found) fail('No plugin manifest found. Expected .veyo-plugin/plugin.json (or .claude-plugin/plugin.json).');
  const manifestFile = path.join(root, ...found.file.split('/'));
  const stat = await fs.stat(manifestFile);
  if (stat.size > LIMITS.manifestBytes) fail('The manifest is too large (limit 256 KB).');
  const raw = parseJSON(await fs.readFile(manifestFile, 'utf8'), 'manifest');
  const manifest = validateManifest(raw, found.format);
  const unsupported = [];
  let contributes;
  if (found.format === 'veyo') {
    const c = raw.contributes || {};
    const known = ['commands', 'agents', 'prompts', 'skills', 'mcpServers', 'themes'];
    unsupported.push(...Object.keys(c).filter((key) => !known.includes(key)));
    contributes = {
      commands: await commands(root, c.commands),
      agents: await agents(root, c.agents),
      prompts: await promptFiles(root, asList(c.prompts, 'prompts')),
      skills: await skillFiles(root, asList(c.skills, 'skills')),
      mcpServers:
        c.mcpServers === undefined
          ? []
          : mcpServers(
              typeof c.mcpServers === 'string'
                ? parseJSON(await readSmall(await resolveInside(root, relPath(c.mcpServers, 'mcpServers'), 'mcpServers'), 'MCP server file'), 'MCP server file')
                : c.mcpServers,
            ),
      themes: await themes(root, c.themes),
    };
  } else {
    // Claude Code layout: fields override the conventional folders.
    const promptDirs = raw.commands !== undefined ? asList(raw.commands, 'commands') : (await exists(root, 'commands')) ? ['commands'] : [];
    const skillDirs = raw.skills !== undefined ? asList(raw.skills, 'skills') : (await exists(root, 'skills')) ? ['skills'] : [];
    let servers = [];
    if (raw.mcpServers && typeof raw.mcpServers === 'object') servers = mcpServers(raw.mcpServers);
    else {
      const file = typeof raw.mcpServers === 'string' ? relPath(raw.mcpServers, 'mcpServers') : (await exists(root, '.mcp.json')) ? '.mcp.json' : null;
      if (file) servers = mcpServers(parseJSON(await readSmall(await resolveInside(root, file, 'mcpServers'), 'MCP server file'), 'MCP server file'));
    }
    for (const [field, folderName] of Object.entries(CLAUDE_UNSUPPORTED))
      if (raw[field] !== undefined || (folderName && (await exists(root, folderName)))) unsupported.push(field);
    contributes = {
      commands: [],
      agents: [],
      prompts: await promptFiles(root, promptDirs),
      skills: await skillFiles(root, skillDirs),
      mcpServers: servers,
      themes: [],
    };
  }
  let readme;
  for (const name of ['README.md', 'readme.md', 'Readme.md'])
    if (await exists(root, name)) {
      readme = await readSmall(path.join(root, name), 'README', LIMITS.manifestBytes).catch(() => undefined);
      break;
    }
  const renamed = listedName && NAME.test(listedName) && listedName !== manifest.name;
  return {
    ...manifest,
    name: renamed ? listedName : manifest.name,
    ...(renamed && { manifestName: manifest.name }),
    version: manifest.version || fallbackVersion,
    format: found.format,
    compatible: !manifest.minAppVersion || compareVersions(appVersion, manifest.minAppVersion) >= 0,
    contributes,
    unsupported: [...new Set(unsupported)],
    readme,
  };
}

module.exports = {
  NAME,
  SEMVER,
  BYPASS_FLAGS,
  THEME_COLORS,
  PluginError,
  checkArgs,
  compareVersions,
  isBatch,
  loadPlugin,
  relPath,
  validateManifest,
};
