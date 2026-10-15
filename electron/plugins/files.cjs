const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const LIMITS = {
  manifestBytes: 256 * 1024,
  fileBytes: 1024 * 1024,
  files: 2000,
  totalBytes: 50 * 1024 * 1024,
  depth: 16,
  contributions: 50,
};

/** An error whose message is written for the person installing the plugin. */
class PluginError extends Error {}

/*
 * Lists every regular file under `root` (posix-style relative paths), refusing
 * links of any kind and anything over the size limits. Plugins are untrusted,
 * so a link is never followed: it could point anywhere on disk.
 */
async function scanTree(root, { exclude = [] } = {}) {
  const files = [];
  let bytes = 0;
  const queue = [{ dir: root, rel: '', depth: 0 }];
  while (queue.length) {
    const { dir, rel, depth } = queue.shift();
    if (depth > LIMITS.depth) throw new PluginError(`"${rel}" is nested too deeply (limit ${LIMITS.depth} folders).`);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!rel && exclude.includes(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) throw new PluginError(`"${childRel}" is a link. Plugins cannot contain links.`);
      if (stat.isDirectory()) {
        queue.push({ dir: full, rel: childRel, depth: depth + 1 });
        continue;
      }
      if (!stat.isFile()) throw new PluginError(`"${childRel}" is not a regular file.`);
      if (stat.size > LIMITS.fileBytes) throw new PluginError(`"${childRel}" is larger than the 1 MB per-file limit.`);
      bytes += stat.size;
      files.push(childRel);
      if (files.length > LIMITS.files) throw new PluginError('The plugin has more than 2,000 files.');
      if (bytes > LIMITS.totalBytes) throw new PluginError('The plugin is larger than 50 MB.');
    }
  }
  return { files: files.sort(), bytes };
}

/** Copies a scanned tree as plain files. The destination must not exist yet. */
async function copyTree(source, target, options = {}) {
  const { files } = await scanTree(source, options);
  await fs.mkdir(target, { recursive: true });
  for (const rel of files) {
    const from = path.join(source, ...rel.split('/'));
    // Recheck right before reading, so a file swapped for a link after the scan is refused.
    if ((await fs.lstat(from)).isSymbolicLink()) throw new PluginError(`"${rel}" is a link. Plugins cannot contain links.`);
    const to = path.join(target, ...rel.split('/'));
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  }
  return files;
}

/** A stable hash of a tree's paths and contents; names local plugins that have no version. */
async function hashTree(root) {
  const { files } = await scanTree(root);
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(`${rel}\0`);
    hash.update(await fs.readFile(path.join(root, ...rel.split('/'))));
    hash.update('\0');
  }
  return hash.digest('hex');
}

module.exports = { LIMITS, PluginError, scanTree, copyTree, hashTree };
