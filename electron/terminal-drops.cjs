const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Images dropped on a terminal that have no file of their own (dragged out of
// a web page) are saved here, so the agent can be handed a path like any
// other image file.
const MAX_BYTES = 20 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 20_000;

/** The image format from the file's own bytes; whatever the name or server claims. */
function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'webp';
  return '';
}

/** A readable file name stem, without anything a shell or path would trip on. */
function stem(name) {
  const base = path.basename(String(name || '')).replace(/\.[^.]*$/, '');
  const clean = base.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return clean || 'image';
}

function createTerminalDrops(directory, { fetch } = {}) {
  async function prune(now) {
    let files;
    try {
      files = await fs.readdir(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(
      files.map(async (file) => {
        const target = path.join(directory, file);
        const stat = await fs.stat(target).catch(() => null);
        if (stat?.isFile() && now - stat.mtimeMs > KEEP_MS) await fs.unlink(target).catch(() => {});
      }),
    );
  }

  async function save(bytes, name) {
    if (!bytes.length) throw new Error('The dropped image is empty.');
    if (bytes.length > MAX_BYTES) throw new Error('Dropped images must be under 20 MB.');
    const extension = imageExtension(bytes);
    if (!extension) throw new Error('Drop a PNG, JPEG, GIF or WebP image.');
    await fs.mkdir(directory, { recursive: true });
    await prune(Date.now());
    const file = path.join(directory, `${stem(name)}-${randomUUID().slice(0, 8)}.${extension}`);
    await fs.writeFile(file, bytes, { flag: 'wx' });
    return file;
  }

  return {
    /** Saves image bytes the renderer read from a dropped file or data: URL. */
    async saveImage(input) {
      if (
        !input ||
        typeof input.data !== 'string' ||
        input.data.length > Math.ceil(MAX_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)
      )
        throw new Error('Invalid dropped image.');
      return save(Buffer.from(input.data, 'base64'), input.name);
    },
    /** Downloads an image dragged out of a web page by its address. */
    async downloadImage(url) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error('Invalid image address.');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        throw new Error('Only web images can be downloaded.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      try {
        const response = await fetch(parsed.href, { signal: controller.signal });
        if (!response.ok) throw new Error(`The image could not be downloaded (HTTP ${response.status}).`);
        if (Number(response.headers.get('content-length')) > MAX_BYTES)
          throw new Error('Dropped images must be under 20 MB.');
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_BYTES) {
            controller.abort();
            throw new Error('Dropped images must be under 20 MB.');
          }
          chunks.push(Buffer.from(chunk));
        }
        let name = parsed.pathname;
        try {
          name = decodeURIComponent(name);
        } catch {
          // Keep the raw path; stem() strips anything unusual.
        }
        return await save(Buffer.concat(chunks), name);
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('The image took too long to download.');
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = { createTerminalDrops, imageExtension };
