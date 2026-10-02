const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_COUNT = 8;
const MAX_TOTAL = 20 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const validId = (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
function decode(input) {
  if (
    !input ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 255 ||
    typeof input.data !== 'string' ||
    input.data.length > 7 * 1024 * 1024 ||
    input.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)
  )
    throw new Error('Invalid attachment.');
  const bytes = Buffer.from(input.data, 'base64');
  const isImage = imageTypes.has(input.mimeType);
  const limit = (isImage ? 5 : 1) * 1024 * 1024;
  if (!bytes.length || bytes.length > limit)
    throw new Error(
      `${input.name}: ${isImage ? 'images must be under 5 MB' : 'text files must be under 1 MB'}.`,
    );
  if (isImage) {
    const signatures = {
      'image/png': bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      'image/jpeg': bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
      'image/gif': /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')),
      'image/webp':
        bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP',
    };
    if (!signatures[input.mimeType])
      throw new Error(`${input.name}: the image format does not match its contents.`);
  } else {
    if (input.kind !== 'text' || bytes.includes(0))
      throw new Error(
        `${input.name}: attach a PNG, JPEG, GIF, WebP image or a UTF-8 text/code file.`,
      );
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${input.name}: the file must contain UTF-8 text.`);
    }
  }
  return {
    name: path.basename(input.name),
    kind: isImage ? 'image' : 'text',
    mimeType: isImage ? input.mimeType : 'text/plain',
    bytes,
  };
}

function createAttachmentStore(directory) {
  // Newly imported files may not be referenced by the next (older) autosave.
  const pending = new Set();
  const locate = (id) => {
    if (!validId(id)) throw new Error('Invalid attachment ID.');
    return path.join(directory, `${id}.json`);
  };
  const read = async (id) => {
    try {
      const file = locate(id);
      const stat = await fs.stat(file);
      if (stat.size > 7 * 1024 * 1024) throw new Error('Attachment is too large.');
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      const decoded = decode(saved);
      return {
        id,
        name: decoded.name,
        kind: decoded.kind,
        mimeType: decoded.mimeType,
        size: decoded.bytes.length,
        data: saved.data,
        ...(decoded.kind === 'text' && { content: new TextDecoder().decode(decoded.bytes) }),
      };
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new Error('An attached file is missing. Remove it and attach it again.');
      throw error;
    }
  };
  return {
    read,
    async store(inputs) {
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > MAX_COUNT)
        throw new Error('Attach up to 8 files at a time.');
      const decoded = inputs.map(decode);
      if (decoded.reduce((sum, item) => sum + item.bytes.length, 0) > MAX_TOTAL)
        throw new Error('Attachments must total less than 20 MB.');
      await fs.mkdir(directory, { recursive: true });
      const stored = [];
      for (const item of decoded) {
        const id = randomUUID();
        const { bytes, ...metadata } = item;
        await fs.writeFile(
          locate(id),
          JSON.stringify({ ...metadata, data: bytes.toString('base64') }),
          { flag: 'wx' },
        );
        pending.add(id);
        stored.push({ id, ...metadata, size: bytes.length });
      }
      return stored;
    },
    async resolve(references = []) {
      if (!Array.isArray(references) || references.length > MAX_COUNT)
        throw new Error('Attach up to 8 files per message.');
      const files = await Promise.all(references.map((item) => read(item?.id)));
      if (files.reduce((sum, item) => sum + item.size, 0) > MAX_TOTAL)
        throw new Error('Attachments must total less than 20 MB.');
      return files;
    },
    async prune(state) {
      const referenced = new Set();
      for (const thread of state?.threads || []) {
        for (const file of thread.draftAttachments || [])
          if (validId(file?.id)) referenced.add(file.id);
        for (const message of thread.messages || [])
          for (const file of message.attachments || [])
            if (validId(file?.id)) referenced.add(file.id);
      }
      for (const id of referenced) pending.delete(id);
      let files;
      try {
        files = await fs.readdir(directory);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for (const file of files) {
        const id = file.endsWith('.json') ? file.slice(0, -5) : '';
        if (validId(id) && !referenced.has(id) && !pending.has(id))
          await fs.unlink(locate(id)).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
      }
    },
  };
}
module.exports = { createAttachmentStore, MAX_COUNT, MAX_TOTAL };
