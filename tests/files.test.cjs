const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../electron/core.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp files '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('round-trips actual UTF-8 files in folders containing spaces', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'hello world.ts'), 'const message = "hello 🌍";\r\n');
  const before = await core.readFile(root, 'hello world.ts');
  const result = await core.saveFile(
    root,
    'hello world.ts',
    'export const answer = 42;\r\n',
    before.revision,
  );
  assert.equal(result.conflict, false);
  assert.equal(
    await fs.readFile(path.join(root, 'hello world.ts'), 'utf8'),
    'export const answer = 42;\r\n',
  );
  assert.equal((await core.readFile(root, 'hello world.ts')).revision, result.revision);
  assert.deepEqual(await fs.readdir(root), ['hello world.ts']);
});
test('refuses to overwrite changes from an external editor', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'original');
  const before = await core.readFile(root, 'file.txt');
  await fs.writeFile(path.join(root, 'file.txt'), 'external change');
  const result = await core.saveFile(root, 'file.txt', 'my unsaved change', before.revision);
  assert.equal(result.conflict, true);
  assert.equal(result.content, 'external change');
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'external change');
});
test('serializes simultaneous saves and reports the stale revision', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'original');
  const before = await core.readFile(root, 'file.txt');
  const results = await Promise.all([
    core.saveFile(root, 'file.txt', 'first', before.revision),
    core.saveFile(root, 'file.txt', 'second', before.revision),
  ]);
  assert.equal(results.filter((r) => r.conflict).length, 1);
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'first');
});
test('rejects traversal, absolute paths, and sibling-prefix escapes', async (t) => {
  const root = await fixture(t);
  await assert.rejects(core.resolveFile(root, '../outside.txt'), /outside/);
  await assert.rejects(core.resolveFile(root, path.join(root, 'file.txt')), /relative/);
  assert.equal(core.inside(root, root + '-other'), false);
});
test('rejects directory links leaving the project', async (t) => {
  const root = await fixture(t),
    outside = await fixture(t);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'not part of project');
  await fs.symlink(
    outside,
    path.join(root, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(core.readFile(root, 'linked/secret.txt'), /outside/);
});
test('rejects binary, invalid UTF-8, and oversized files', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(root, 'invalid'), Buffer.from([0xff, 0xfe]));
  await fs.writeFile(path.join(root, 'large'), Buffer.alloc(4 * 1024 * 1024 + 1, 65));
  await assert.rejects(core.readFile(root, 'binary'), /Binary/);
  await assert.rejects(core.readFile(root, 'invalid'), /UTF-8/);
  await assert.rejects(core.readFile(root, 'large'), /4 MB/);
});
test('search skips dependency and Git folders and finds nested filenames', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'src', 'App.tsx'), 'hello');
  await fs.writeFile(path.join(root, 'node_modules', 'App.tsx'), 'ignored');
  assert.deepEqual(
    (await core.searchFiles(root, 'app')).map((e) => e.path),
    ['src/App.tsx'],
  );
});

test('explorer can include dependencies and build files while protecting Git metadata', async (t) => {
  const root = await fixture(t);
  for (const dir of ['node_modules', 'dist', '.git', 'src']) await fs.mkdir(path.join(root, dir));
  await fs.writeFile(path.join(root, 'README.md'), 'hello');
  assert.deepEqual((await core.listFiles(root)).map(entry => entry.name), ['src', 'README.md']);
  assert.deepEqual((await core.listFiles(root, '', true)).map(entry => entry.name), ['dist', 'node_modules', 'src', 'README.md']);
  assert.deepEqual((await core.listFiles(root, '', 'true')).map(entry => entry.name), ['src', 'README.md']);
});

test('saving preserves a UTF-8 BOM and CRLF without leaving temporary files', async (t) => {
  const root = await fixture(t);
  const original = '\uFEFFfirst\r\nsecond\r\n';
  await fs.writeFile(path.join(root, 'bom.txt'), original);
  const disk = await core.readFile(root, 'bom.txt');
  assert.equal(disk.content, original);
  const content = '\uFEFFedited\r\nsecond\r\n';
  await core.saveFile(root, 'bom.txt', content, disk.revision);
  assert.equal(await fs.readFile(path.join(root, 'bom.txt'), 'utf8'), content);
  assert.deepEqual(await fs.readdir(root), ['bom.txt']);
});
