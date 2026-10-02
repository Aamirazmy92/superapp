const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const core = require('../electron/core.cjs');
const git = require('../electron/git.cjs');
const chat = require('../electron/chat.cjs');
const {
  normalizeState,
  normalizeSession,
  normalizeRunPresets,
  normalizeChat,
} = require('../electron/state.cjs');

test('run presets are kept per known project and cleaned', () => {
  const state = normalizeState({
    projects: [{ id: 'p', name: 'Project', root: 'D:/project' }],
    runPresets: {
      p: [{ name: 'Dev', command: 'npm run dev', extra: 1 }, { name: 'bad' }, null],
      gone: [{ name: 'Old', command: 'x' }],
    },
  });
  assert.deepEqual(state.runPresets, { p: [{ name: 'Dev', command: 'npm run dev' }] });
  assert.deepEqual(normalizeState({ projects: [] }).runPresets, {});
  assert.throws(() => normalizeRunPresets('bad'));
});
test('chat state keeps threads and known settings only', () => {
  const chat = normalizeChat({
    threads: [{ id: 't', title: 'Hi', messages: [] }, { title: 'no id' }, null],
    active: 't',
    settings: {
      provider: 'claude',
      speakReplies: 'yes',
      unknown: 'x',
      modelEfforts: { 'claude:opus': 'high', bad: 5 },
    },
  });
  assert.deepEqual(chat.threads.map((t) => t.id), ['t']);
  assert.equal(chat.active, 't');
  assert.deepEqual(chat.settings, { provider: 'claude', modelEfforts: { 'claude:opus': 'high' } });
  assert.deepEqual(normalizeChat('bad'), { threads: [], active: null, settings: { modelEfforts: {} } });
});

test('session recovery preserves drafts and presets while repairing malformed metadata', () => {
  const draft = { path: 'file.txt', content: 'unsaved', saved: 'disk', revision: 'hash', conflict: { invalid: true } };
  const state = normalizeState({ projects: [null, { id: 'p', name: 'Project', root: 'D:/project' }], activeProject: 'missing', sessions: { p: { files: [null, draft], layout: 'invalid', terminalHeight: -10, workspaceNames: ['Main', 'Main'], terminalPresets: [{ label: 'Shell', shell: 'cmd', workspaceName: 'Task' }] } } });
  assert.equal(state.activeProject, 'p');
  assert.equal(state.sessions.p.files[0].content, 'unsaved');
  assert.equal(state.sessions.p.files[0].conflict, undefined);
  assert.deepEqual(state.sessions.p.workspaceNames, ['Main', 'Task']);
  assert.equal(state.sessions.p.terminalHeight, 160);
  assert.equal(normalizeSession({ files: 'bad', terminalPresets: {} }).files.length, 0);
});
test('workspace metadata keeps valid flags and groups for known workspaces only', () => {
  const session = normalizeSession({
    workspaceNames: ['Main', 'Task'],
    workspaceMeta: {
      Main: { pinned: true, unread: 'yes', group: '  Frontend ' },
      Task: { archived: true, group: 'x'.repeat(41) },
      Gone: { pinned: true },
      Empty: null,
    },
  });
  assert.deepEqual(session.workspaceMeta, {
    Main: { pinned: true, group: 'Frontend' },
    Task: { archived: true },
  });
  assert.deepEqual(normalizeSession({ workspaceMeta: 'bad' }).workspaceMeta, {});
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp audit '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('file management creates, moves and protects existing files and drafts', async (t) => {
  const root = await fixture(t);
  await core.createEntry(root, 'folder', true);
  await core.createEntry(root, 'original.txt');
  const original = await core.readFile(root, 'original.txt');
  await core.saveFile(root, 'original.txt', 'keep this content', original.revision);
  await core.renameEntry(root, 'original.txt', 'folder/moved.txt');
  assert.equal((await core.readFile(root, 'folder/moved.txt')).content, 'keep this content');
  await assert.rejects(core.readFile(root, 'original.txt'), /ENOENT/);
  await assert.rejects(core.createEntry(root, 'folder/moved.txt'), /EEXIST/);
  await core.createEntry(root, 'other.txt');
  await assert.rejects(core.renameEntry(root, 'other.txt', 'folder/moved.txt'), /already exists/);
  assert.equal((await core.readFile(root, 'folder/moved.txt')).content, 'keep this content');
  assert.equal(
    await core.trashTarget(root, 'folder/moved.txt'),
    path.join(root, 'folder', 'moved.txt'),
  );
});
test('file mutations reject protected paths, invalid names and linked escapes', async (t) => {
  const root = await fixture(t),
    outside = await fixture(t);
  for (const invalid of [
    '',
    '.',
    '../escape',
    '.git/config',
    'nested/../escape',
    'file:stream',
    'NUL.txt',
    'trailing.',
  ]) {
    await assert.rejects(core.createEntry(root, invalid), /relative/);
    await assert.rejects(core.trashTarget(root, invalid), /relative/);
  }
  await fs.symlink(
    outside,
    path.join(root, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(core.createEntry(root, 'linked/escape'), /outside/);
});
test('content search returns useful line locations, handles case and skips binary/dependencies', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'First line\nHello Needle\nneedle again');
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules/skip.txt'), 'needle');
  const result = await core.searchContent(root, 'needle');
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.matches.map(({ line, column }) => [line, column]),
    [
      [2, 7],
      [3, 1],
    ],
  );
  assert.equal((await core.searchContent(root, 'Needle', true)).matches.length, 1);
  await fs.writeFile(path.join(root, 'many.txt'), 'needle\n'.repeat(300));
  const limited = await core.searchContent(root, 'needle');
  assert.equal(limited.matches.length, 200);
  assert.equal(limited.truncated, true);
});
test('Git supports first commit, staged/unstaged diffs, deletion and literal wildcard paths', async (t) => {
  const root = await fixture(t);
  const command = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true });
  command('init');
  command('config', 'user.name', 'Workspace Test');
  command('config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(root, '[special].txt'), 'first\n');
  assert.match(await git.diff(root, '[special].txt'), /first/);
  await git.stage(root, '[special].txt');
  await git.unstage(root, '[special].txt');
  assert.equal((await git.status(root)).files[0].status, '??');
  await git.stage(root, '[special].txt');
  await git.commit(root, 'Initial test commit');
  await fs.writeFile(path.join(root, '[special].txt'), 'second\n');
  assert.match(await git.diff(root, '[special].txt'), /\+second/);
  await git.stage(root, '[special].txt');
  assert.match(await git.diff(root, '[special].txt', true), /\+second/);
  assert.equal(await git.diff(root, '[special].txt', false), '');
  await git.unstage(root, '[special].txt');
  assert.equal((await git.status(root)).files[0].status, ' M');
  await fs.unlink(path.join(root, '[special].txt'));
  await git.stage(root, '[special].txt');
  await git.commit(root, 'Delete test file');
  assert.equal((await git.status(root)).files.length, 0);
  await assert.rejects(git.commit(root, 'Empty'), /Stage changes/);
});
test('Git preserves both sides of staged renames when unstaging', async (t) => {
  const root = await fixture(t);
  const command = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true });
  command('init');
  command('config', 'user.name', 'Test');
  command('config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(root, 'old.txt'), 'content\n');
  await git.stage(root, 'old.txt');
  await git.commit(root, 'Initial');
  command('mv', 'old.txt', 'new.txt');
  const entry = (await git.status(root)).files[0];
  assert.equal(entry.originalPath, 'old.txt');
  assert.match(await git.diff(root, 'new.txt', true), /rename from old.txt/);
  await git.unstage(root, 'new.txt');
  assert.ok((await git.status(root)).files.every((file) => [' ', '?'].includes(file.status[0])));
});

test('automatic Git status does not run a repository fsmonitor command', async (t) => {
  const root = await fixture(t);
  const command = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true });
  command('init');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'content');
  command('add', 'tracked.txt');
  const marker = path.join(root, 'fsmonitor-ran');
  const hook = path.join(root, 'fsmonitor.sh');
  await fs.writeFile(hook, '#!/bin/sh\nprintf ran > fsmonitor-ran\n');
  await fs.chmod(hook, 0o755);
  command('config', 'core.fsmonitor', './fsmonitor.sh');
  command('status', '--porcelain');
  assert.equal(await fs.readFile(marker, 'utf8').then(() => true, () => false), true);
  await fs.unlink(marker);
  assert.equal((await git.status(root)).available, true);
  assert.equal(await fs.readFile(marker, 'utf8').then(() => true, () => false), false);
});
test('chat validates local endpoints and supports responses, provider errors and cancellation', async (t) => {
  for (const endpoint of [
    'https://example.com',
    'http://user:pass@localhost:11434',
    'http://localhost:11434/other',
    'http://127.0.0.1.example.com',
  ])
    assert.throws(() => chat.localEndpoint(endpoint));
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/tags')
      return res.end(JSON.stringify({ models: [{ name: 'test-model' }] }));
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    assert.equal(body.stream, true);
    if (body.model === 'wait') return;
    if (body.model === 'missing') {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'model not found' }));
    }
    if (body.model === 'truncated')
      return res.end('{"message":{"content":"partial"},"done":false}\n');
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.write('{"message":{"content":"Reply to: "},"done":false}\n{"message":{"content":"hel');
    res.end('lo"},"done":false}\n{"done":true}\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await chat.models(endpoint), ['test-model']);
  const request = { endpoint, model: 'test-model', messages: [{ role: 'user', content: 'hello' }] };
  const chunks = [];
  assert.equal(await chat.send(request, undefined, (chunk) => chunks.push(chunk)), 'Reply to: hello');
  assert.deepEqual(chunks, ['Reply to: ', 'hello']);
  await assert.rejects(chat.send({ ...request, model: 'missing' }), /model not found/);
  await assert.rejects(chat.send({ ...request, model: 'truncated' }), /before completion/);
  await assert.rejects(
    chat.send({ ...request, model: 'wait' }, AbortSignal.timeout(80)),
    /abort|timeout/i,
  );
  await assert.rejects(
    chat.send({ ...request, messages: [{ role: 'bogus', content: 'hello' }] }),
    /Choose a model/,
  );
});
