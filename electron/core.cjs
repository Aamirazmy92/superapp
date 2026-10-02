const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_FILE = 4 * 1024 * 1024;
const ignored = new Set([
  'node_modules',
  '.git',
  'dist',
  'release',
  '.next',
  '.cache',
  'coverage',
  '.npm-cache',
  '.superapp-dev',
  '.playwright-cli',
]);
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
async function resolveFile(root, relative = '') {
  if (typeof relative !== 'string' || path.isAbsolute(relative))
    throw new Error('Expected a project-relative path.');
  const base = await fs.realpath(root);
  const target = path.resolve(base, relative);
  if (!inside(base, target)) throw new Error('Path is outside this project.');
  const real = await fs.realpath(target);
  if (!inside(base, real)) throw new Error('Links outside this project cannot be opened.');
  return real;
}
async function readFile(root, relative) {
  const target = await resolveFile(root, relative);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error('Select a file.');
  if (stat.size > MAX_FILE) throw new Error('This file is larger than the 4 MB editor limit.');
  const bytes = await fs.readFile(target);
  if (bytes.includes(0)) throw new Error('Binary files cannot be edited as text.');
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('This editor currently supports UTF-8 text files only.');
  }
  return { content, revision: hash(bytes) };
}
const writes = new Map();
async function saveFile(root, relative, content, revision) {
  // Queue before any asynchronous path lookup so calls retain arrival order.
  // Project grants already use canonical roots; one queue also covers aliases.
  const key = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
  const previous = writes.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => saveFileUnlocked(root, relative, content, revision));
  writes.set(key, next);
  try {
    return await next;
  } finally {
    if (writes.get(key) === next) writes.delete(key);
  }
}
async function saveFileUnlocked(root, relative, content, revision) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE)
    throw new Error('Invalid file contents or file too large.');
  const target = await resolveFile(root, relative);
  const current = await fs.readFile(target);
  if (hash(current) !== revision) return { conflict: true, ...(await readFile(root, relative)) };
  const stat = await fs.stat(target);
  const temp = `${target}.superapp-${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { flag: 'wx', mode: stat.mode });
    // Recheck after preparing the write, so known external changes are never overwritten.
    if (hash(await fs.readFile(target)) !== revision)
      return { conflict: true, ...(await readFile(root, relative)) };
    await fs.rename(temp, target);
    return { conflict: false, revision: hash(Buffer.from(content)) };
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}
async function listFiles(root, relative = '', includeIgnored = false) {
  const target = await resolveFile(root, relative);
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries
    .filter((e) => e.name !== '.git' && (includeIgnored === true || !ignored.has(e.name)) && !e.isSymbolicLink())
    .map((e) => ({
      name: e.name,
      path: path.join(relative, e.name).replaceAll('\\', '/'),
      directory: e.isDirectory(),
    }))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}
async function searchFiles(root, query) {
  if (typeof query !== 'string' || !query.trim()) return [];
  const results = [];
  let visited = 0;
  const queue = [''];
  while (queue.length && results.length < 150 && visited < 15000) {
    const dir = queue.shift();
    for (const entry of await listFiles(root, dir).catch(() => [])) {
      visited++;
      if (entry.directory) queue.push(entry.path);
      else if (entry.path.toLowerCase().includes(query.toLowerCase())) results.push(entry);
      if (results.length >= 150) break;
    }
  }
  return results;
}
function validateRelative(relative) {
  if (
    typeof relative !== 'string' ||
    !relative.trim() ||
    path.isAbsolute(relative) ||
    relative
      .split(/[\\/]/)
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.toLowerCase() === '.git' ||
          /[<>:"|?*\x00-\x1f]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error('Use a valid project-relative path, without .git or parent traversal.');
  return relative;
}
async function destination(root, relative) {
  validateRelative(relative);
  const parent = await resolveFile(root, path.dirname(relative));
  const target = path.join(parent, path.basename(relative));
  validateRelative(path.relative(await fs.realpath(root), target));
  return target;
}
async function createEntry(root, relative, directory = false) {
  const target = await destination(root, relative);
  if (directory) await fs.mkdir(target);
  else await fs.writeFile(target, '', { flag: 'wx' });
  return { name: path.basename(relative), path: relative.replaceAll('\\', '/'), directory };
}
async function renameEntry(root, relative, nextPath) {
  validateRelative(relative);
  const target = await resolveFile(root, relative);
  validateRelative(path.relative(await fs.realpath(root), target));
  const next = await destination(root, nextPath);
  if (target === next) return;
  if (process.platform === 'win32' && target.toLowerCase() === next.toLowerCase()) {
    const temporary = `${target}.superapp-${crypto.randomUUID()}.tmp`;
    await fs.rename(target, temporary);
    try { await fs.rename(temporary, next); }
    catch (error) { await fs.rename(temporary, target); throw error; }
    return;
  }
  try {
    await fs.lstat(next);
    throw new Error('A file or folder already exists at that path.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if ((await fs.lstat(target)).isFile()) {
    // Creating a hard link is exclusive: a concurrently-created destination
    // cannot be overwritten, unlike rename on POSIX.
    await fs.link(target, next);
    try {
      await fs.unlink(target);
    } catch (error) {
      await fs.unlink(next).catch(() => {});
      throw error;
    }
  } else await fs.rename(target, next);
}
async function trashTarget(root, relative) {
  validateRelative(relative);
  if ((await fs.lstat(path.resolve(root, relative))).isSymbolicLink())
    throw new Error('Manage symbolic links from a terminal.');
  const target = await resolveFile(root, relative);
  validateRelative(path.relative(await fs.realpath(root), target));
  return target;
}
async function searchContent(root, query, caseSensitive = false) {
  if (typeof query !== 'string' || !query.trim() || query.length > 500)
    return { matches: [], truncated: false };
  const matches = [],
    queue = [''];
  const needle = caseSensitive ? query : query.toLowerCase();
  let visited = 0,
    bytes = 0;
  while (queue.length && visited < 10000 && bytes < 32 * 1024 * 1024) {
    const dir = queue.shift();
    for (const entry of await listFiles(root, dir).catch(() => [])) {
      if (++visited > 10000) break;
      if (entry.directory) {
        queue.push(entry.path);
        continue;
      }
      let file;
      try {
        const target = await resolveFile(root, entry.path);
        const stat = await fs.stat(target);
        if (stat.size > 512 * 1024) continue;
        bytes += stat.size;
        if (bytes > 32 * 1024 * 1024) break;
        file = await readFile(root, entry.path);
      } catch {
        continue;
      }
      const lines = file.content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const column = (caseSensitive ? lines[index] : lines[index].toLowerCase()).indexOf(needle);
        if (column < 0) continue;
        matches.push({
          path: entry.path,
          line: index + 1,
          column: column + 1,
          text: lines[index].slice(Math.max(0, column - 60), column + 240),
        });
        if (matches.length >= 200) return { matches, truncated: true };
      }
    }
  }
  return { matches, truncated: queue.length > 0 || visited >= 10000 || bytes >= 32 * 1024 * 1024 };
}
module.exports = {
  inside,
  resolveFile,
  readFile,
  saveFile,
  listFiles,
  searchFiles,
  validateRelative,
  createEntry,
  renameEntry,
  trashTarget,
  searchContent,
};
