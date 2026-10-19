const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTerminalDrops } = require('../electron/terminal-drops.cjs');
const { droppedImageAddress, pasteTarget, quotePath, resolveDrop } = require('../src/terminalDrop.ts');

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo drops '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('quotes paths the shell would split', () => {
  assert.equal(quotePath('C:\\shots\\a.png'), 'C:\\shots\\a.png');
  assert.equal(quotePath('C:\\My Pictures\\a b.png'), '"C:\\My Pictures\\a b.png"');
  assert.equal(quotePath('C:\\x\\(1).png'), '"C:\\x\\(1).png"');
});

test('PowerShell gets single quotes, so a file name cannot run a command', () => {
  assert.equal(quotePath('C:\\shots\\a.png', 'powershell'), 'C:\\shots\\a.png');
  assert.equal(quotePath('C:\\x\\$(calc).png', 'powershell'), "'C:\\x\\$(calc).png'");
  assert.equal(quotePath('C:\\x\\$env:USERNAME.png', 'powershell'), "'C:\\x\\$env:USERNAME.png'");
  assert.equal(quotePath("C:\\x\\it's `here`.png", 'powershell'), "'C:\\x\\it''s `here`.png'");
  // PowerShell treats typographic single quotes as quotes too.
  assert.equal(quotePath('C:\\x\\a\u2019b.png', 'powershell'), "'C:\\x\\a\u2019\u2019b.png'");
});

test('Command Prompt refuses names it would expand even inside quotes', () => {
  assert.equal(quotePath('C:\\My Pictures\\a&b.png', 'cmd'), '"C:\\My Pictures\\a&b.png"');
  assert.throws(() => quotePath('C:\\x\\%PATH%.png', 'cmd'), /cannot be pasted/);
  assert.throws(() => quotePath('C:\\x\\wow!.png', 'cmd'), /cannot be pasted/);
});

test('POSIX shells get single quotes', () => {
  assert.equal(quotePath('/tmp/a.png', 'posix'), '/tmp/a.png');
  assert.equal(quotePath('/tmp/$(id) a.png', 'posix'), "'/tmp/$(id) a.png'");
  assert.equal(quotePath("/tmp/it's.png", 'posix'), "'/tmp/it'\\''s.png'");
});

test('names with control characters are refused in every terminal', () => {
  for (const kind of [undefined, 'powershell', 'cmd', 'posix'])
    assert.throws(() => quotePath('/tmp/a\nrm -rf ~\n.png', kind), /cannot be pasted/);
});

test('finds the image dragged out of a page, not plain links', () => {
  assert.equal(
    droppedImageAddress({
      uriList: 'https://example.com/page',
      html: '<a href="/page"><img alt="x" src="https://cdn.example.com/cat?w=1&amp;h=2"></a>',
    }),
    'https://cdn.example.com/cat?w=1&h=2',
  );
  assert.equal(droppedImageAddress({ uriList: 'https://example.com/photo.JPG', html: '' }), 'https://example.com/photo.JPG');
  assert.equal(droppedImageAddress({ uriList: 'https://example.com/article', html: '<a href="x">x</a>' }), '');
  assert.equal(droppedImageAddress({ uriList: '', html: '<img src="/relative.png">' }), '');
  assert.equal(droppedImageAddress({ uriList: 'file:///C:/a.png', html: '' }), '');
  assert.equal(droppedImageAddress({ uriList: '', html: '<img src="data:image/png;base64,AAAA">' }), 'data:image/png;base64,AAAA');
});

test('uses file paths first, saves path-less images, then falls back to the address', async () => {
  const calls = [];
  const api = {
    pathForFile: (file) => file.path ?? '',
    saveDroppedImage: async (image) => { calls.push(['save', image.name]); return 'C:\\saved.png'; },
    downloadDroppedImage: async (url) => { calls.push(['download', url]); return 'C:\\downloaded.png'; },
  };
  const disk = { name: 'a.png', type: 'image/png', size: 4, path: 'C:\\shots\\a.png' };
  const text = { name: 'notes.txt', type: 'text/plain', size: 4, path: 'C:\\notes.txt' };
  assert.deepEqual(await resolveDrop({ files: [disk, text], uriList: 'https://x/y.png', html: '' }, api), ['C:\\shots\\a.png', 'C:\\notes.txt']);
  assert.deepEqual(calls, []);
  assert.deepEqual(await resolveDrop({ files: [], uriList: 'https://x/y.png', html: '' }, api), ['C:\\downloaded.png']);
  assert.deepEqual(await resolveDrop({ files: [], uriList: '', html: '<img src="data:image/png;base64,iVBO">' }, api), ['C:\\saved.png']);
  assert.deepEqual(calls, [['download', 'https://x/y.png'], ['save', 'image']]);
  assert.deepEqual(await resolveDrop({ files: [], uriList: 'https://x/article', html: '' }, api), []);
});

test('saves dropped image bytes under a safe name, checking the format', async (t) => {
  const root = await fixture(t);
  const drops = createTerminalDrops(root);
  const saved = await drops.saveImage({ name: 'My "cat" (1).png', data: PNG.toString('base64') });
  assert.equal(path.dirname(saved), root);
  assert.match(path.basename(saved), /^My-cat-1-[a-f0-9]{8}\.png$/);
  assert.deepEqual(await fs.readFile(saved), PNG);
  await assert.rejects(drops.saveImage({ name: 'evil.png', data: Buffer.from('<svg/>').toString('base64') }), /PNG, JPEG, GIF or WebP/);
  await assert.rejects(drops.saveImage({ name: 'x', data: 'not base64!' }), /Invalid dropped image/);
});

test('removes week-old dropped images when saving a new one', async (t) => {
  const root = await fixture(t);
  const old = path.join(root, 'old.png');
  await fs.writeFile(old, PNG);
  const lastWeek = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await fs.utimes(old, lastWeek, lastWeek);
  await createTerminalDrops(root).saveImage({ name: 'new.png', data: PNG.toString('base64') });
  await assert.rejects(fs.stat(old), { code: 'ENOENT' });
});

test('downloads web images only, within the size limit', async (t) => {
  const root = await fixture(t);
  const responses = {
    'https://x.test/a%20b.png': () => new Response(PNG),
    'https://x.test/missing.png': () => new Response('', { status: 404 }),
    'https://x.test/page.png': () => new Response('<html>'),
    'https://x.test/huge.png': () => new Response(new Uint8Array(21 * 1024 * 1024)),
  };
  const drops = createTerminalDrops(root, { fetch: async (url) => responses[url]() });
  assert.match(path.basename(await drops.downloadImage('https://x.test/a%20b.png')), /^a-b-[a-f0-9]{8}\.png$/);
  await assert.rejects(drops.downloadImage('https://x.test/missing.png'), /HTTP 404/);
  await assert.rejects(drops.downloadImage('https://x.test/page.png'), /PNG, JPEG, GIF or WebP/);
  await assert.rejects(drops.downloadImage('https://x.test/huge.png'), /under 20 MB/);
  await assert.rejects(drops.downloadImage('file:///C:/Windows/win.ini'), /Only web images/);
  assert.equal((await fs.readdir(root)).length, 1);
});

test('agents read the prompt; plain terminals and plugin commands are shells', () => {
  assert.equal(pasteTarget('powershell', 'claude'), 'agent');
  assert.equal(pasteTarget('powershell', 'terminal'), 'powershell');
  assert.equal(pasteTarget('powershell', undefined), 'powershell');
  assert.equal(pasteTarget('cmd', undefined), 'cmd');
  assert.equal(pasteTarget('default', undefined), 'posix');
});
