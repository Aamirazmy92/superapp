const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createAttachmentStore } = require('../electron/chat-attachments.cjs');
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzL0AAAAASUVORK5CYII=';
async function store(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp-attachments-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.ok(path.basename(directory).startsWith('superapp-attachments-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return createAttachmentStore(directory);
}
test('attachments persist separately and resolve from trusted IDs, ignoring tampered metadata', async (t) => {
  const files = await store(t);
  const code = 'export const café = "☕";\n';
  const refs = await files.store([
    { name: 'reference.png', kind: 'image', mimeType: 'image/png', data: png },
    {
      name: '../source.ts',
      kind: 'text',
      mimeType: 'text/plain',
      data: Buffer.from(code).toString('base64'),
    },
  ]);
  assert.equal(refs[1].name, 'source.ts');
  assert.ok(refs.every((file) => file.id && !file.data && !file.content));
  const resolved = await files.resolve(
    refs.map((file) => ({ ...file, name: 'tampered', data: 'ignored' })),
  );
  assert.equal(resolved[0].data, png);
  assert.equal(resolved[1].content, code);
  assert.equal(resolved[0].name, 'reference.png');
  await assert.rejects(files.read('../../private'), /Invalid attachment ID/);
  await assert.rejects(files.read('00000000-0000-0000-0000-000000000000'), /missing/);
});
test('rejects binary, mismatched images, oversized files and oversized batches before storing', async (t) => {
  const files = await store(t);
  const text = {
    name: 'code.ts',
    kind: 'text',
    mimeType: 'text/plain',
    data: Buffer.from('code').toString('base64'),
  };
  await assert.rejects(
    files.store([{ ...text, data: Buffer.from([0, 1, 2]).toString('base64') }]),
    /UTF-8|text\/code/,
  );
  await assert.rejects(
    files.store([{ ...text, data: Buffer.from([255, 254]).toString('base64') }]),
    /UTF-8/,
  );
  await assert.rejects(files.store([{ ...text, kind: 'image', mimeType: 'image/png' }]), /format/);
  await assert.rejects(
    files.store([{ ...text, data: Buffer.alloc(1024 * 1024 + 1, 65).toString('base64') }]),
    /under 1 MB/,
  );
  await assert.rejects(files.store(Array.from({ length: 9 }, () => text)), /8 files/);
  assert.deepEqual(await files.resolve(), []);
});
test('deleting a saved conversation removes its blobs and concurrent imports survive autosave', async (t) => {
  const files = await store(t);
  const refs = await files.store([
    {
      name: 'code.ts',
      kind: 'text',
      mimeType: 'text/plain',
      data: Buffer.from('code').toString('base64'),
    },
  ]);
  await files.prune({ threads: [] });
  assert.equal((await files.read(refs[0].id)).content, 'code');
  await files.prune({ threads: [{ draftAttachments: refs, messages: [] }] });
  await files.prune({ threads: [{ draftAttachments: [], messages: [{ attachments: refs }] }] });
  assert.equal((await files.read(refs[0].id)).content, 'code');
  await files.prune({ threads: [] });
  await assert.rejects(files.read(refs[0].id), /missing/);
});
