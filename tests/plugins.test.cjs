const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadPlugin, validateManifest, checkArgs, compareVersions } = require('../electron/plugins/manifest.cjs');
const { scanTree, copyTree } = require('../electron/plugins/files.cjs');
const { createRegistry, normalizeRegistry, activeEntries, entryKey } = require('../electron/plugins/registry.cjs');

async function tempDir(t, prefix = 'veyo plugin ') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function write(root, rel, content) {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
}
const baseManifest = (extra = {}) => ({
  name: 'hello-veyo',
  version: '1.0.0',
  description: 'Example',
  author: { name: 'Veyo' },
  ...extra,
});
async function plugin(t, manifest, files = {}) {
  const root = await tempDir(t);
  await write(root, '.veyo-plugin/plugin.json', manifest);
  for (const [rel, content] of Object.entries(files)) await write(root, rel, content);
  return root;
}
const load = (root, appVersion = '0.1.0') => loadPlugin(root, { appVersion });

// Manifest -------------------------------------------------------------------

test('loads a complete Veyo plugin with every contribution kind', async (t) => {
  const root = await plugin(
    t,
    baseManifest({
      license: 'MIT',
      homepage: 'https://example.com',
      minAppVersion: '0.1.0',
      contributes: {
        commands: [{ id: 'greet', title: 'Say hello', run: { program: 'node', args: ['${pluginRoot}/scripts/hello.mjs', '${projectRoot}'] } }],
        agents: [{ id: 'reviewer', label: 'Claude reviewer', program: 'claude', args: ['--append-system-prompt', 'Review only.'] }],
        prompts: './prompts',
        skills: './skills',
        mcpServers: './.mcp.json',
        themes: [{ id: 'dusk', label: 'Dusk', path: './themes/dusk.json' }],
      },
    }),
    {
      'scripts/hello.mjs': 'console.log("hi")',
      'prompts/review.md': '---\ndescription: Review the diff\n---\nReview $ARGUMENTS carefully.',
      'skills/tidy/SKILL.md': '---\nname: tidy\ndescription: Tidy code\n---\nTidy it.',
      '.mcp.json': { mcpServers: { docs: { type: 'http', url: 'https://mcp.example.com' }, local: { command: 'node', args: ['server.js'] } } },
      'themes/dusk.json': { base: 'graphite', colors: { chrome: '#101010', stage: '#111111', well: '#121212', raised: '#131313', accent: '#ff8800', foreground: '#eeeeee', muted: '#888888', selection: '#334455', keyword: '#cc99ff', string: '#99cc99' } },
      'README.md': '# Hello',
    },
  );
  const result = await load(root);
  assert.equal(result.name, 'hello-veyo');
  assert.equal(result.format, 'veyo');
  assert.equal(result.compatible, true);
  assert.equal(result.contributes.commands[0].id, 'greet');
  assert.deepEqual(result.contributes.commands[0].run.args, ['${pluginRoot}/scripts/hello.mjs', '${projectRoot}']);
  assert.equal(result.contributes.agents[0].program, 'claude');
  assert.equal(result.contributes.prompts[0].id, 'review');
  assert.equal(result.contributes.prompts[0].description, 'Review the diff');
  assert.equal(result.contributes.prompts[0].body.trim(), 'Review $ARGUMENTS carefully.');
  assert.equal(result.contributes.skills[0].id, 'tidy');
  assert.deepEqual(result.contributes.mcpServers.map((s) => s.name), ['docs', 'local']);
  assert.equal(result.contributes.themes[0].base, 'graphite');
  assert.equal(result.readme, '# Hello');
});

test('rejects invalid names and versions with readable errors', () => {
  assert.throws(() => validateManifest(baseManifest({ name: 'Hello Veyo' }), 'veyo'), /name/i);
  assert.throws(() => validateManifest(baseManifest({ name: 'a'.repeat(65) }), 'veyo'), /name/i);
  assert.throws(() => validateManifest(baseManifest({ version: 'one' }), 'veyo'), /version/i);
  assert.throws(() => validateManifest(baseManifest({ version: undefined }), 'veyo'), /version/i);
  assert.throws(() => validateManifest(baseManifest({ homepage: 'javascript:alert(1)' }), 'veyo'), /homepage/i);
  assert.throws(() => validateManifest('[]', 'veyo'), /object/i);
});

test('rejects absolute and traversing contribution paths', async (t) => {
  for (const bad of ['../outside', '/etc', 'C:\\Windows', '\\\\server\\share', 'prompts/../../x', 'a:b']) {
    const root = await plugin(t, baseManifest({ contributes: { prompts: bad } }));
    await assert.rejects(load(root), /path/i, bad);
  }
});

test('rejects paths that escape the plugin through a link', async (t) => {
  const outside = await tempDir(t);
  await write(outside, 'secret.md', 'secret');
  const root = await plugin(t, baseManifest({ contributes: { prompts: './prompts' } }));
  try {
    await fs.symlink(outside, path.join(root, 'prompts'), 'junction');
  } catch {
    t.skip('Links are not available here.');
    return;
  }
  await assert.rejects(load(root), /link/i);
});

test('enforces manifest, file and count limits', async (t) => {
  const big = await plugin(t, { ...baseManifest(), description: 'x'.repeat(300 * 1024) });
  await assert.rejects(load(big), /manifest.*large|too large/i);
  const huge = await plugin(t, baseManifest(), { 'blob.bin': Buffer.alloc(1024 * 1024 + 1).toString() });
  await assert.rejects(load(huge), /1 MB/);
  const many = await plugin(t, baseManifest());
  await Promise.all(Array.from({ length: 2001 }, (_, i) => write(many, `f/${i}.txt`, '')));
  await assert.rejects(load(many), /2,000 files/);
  const commands = Array.from({ length: 51 }, (_, i) => ({ id: `c${i}`, title: 'x', run: { program: 'node' } }));
  const crowded = await plugin(t, baseManifest({ contributes: { commands } }));
  await assert.rejects(load(crowded), /50/);
});

test('rejects unsafe programs and arguments', async (t) => {
  const cases = [
    [{ program: '../bin/x' }, /program/i],
    [{ program: 'C:\\Windows\\System32\\cmd.exe' }, /program/i],
    [{ program: 'node', args: ['say "hi"'] }, /quote|character/i],
    [{ program: 'node', args: ['line\nbreak'] }, /character/i],
    [{ program: '${pluginRoot}/missing.ps1' }, /not found|missing/i],
    [{ program: 'node', args: 'not-an-array' }, /args/i],
  ];
  for (const [run, pattern] of cases) {
    const root = await plugin(t, baseManifest({ contributes: { commands: [{ id: 'x', title: 'X', run }] } }));
    await assert.rejects(load(root), pattern, JSON.stringify(run));
  }
  const batch = await plugin(t, baseManifest({ contributes: { commands: [{ id: 'x', title: 'X', run: { program: '${pluginRoot}/run.cmd', args: ['100%'] } }] } }), { 'run.cmd': '@echo off' });
  await assert.rejects(load(batch), /cmd/i);
});

test('agent presets cannot change approval settings', async (t) => {
  for (const args of [['--dangerously-skip-permissions'], ['--permission-mode=bypassPermissions'], ['--yolo'], ['-s', 'danger-full-access'], ['--full-auto'], ['--ask-for-approval', 'never'], ['--some-bypass-flag']]) {
    const root = await plugin(t, baseManifest({ contributes: { agents: [{ id: 'a', label: 'A', program: 'codex', args }] } }));
    await assert.rejects(load(root), /approval/i, args.join(' '));
  }
  assert.doesNotThrow(() => checkArgs(['--model', 'sonnet'], { agent: true }));
});

test('imports a Claude Code plugin from its convention folders', async (t) => {
  const root = await tempDir(t);
  await write(root, '.claude-plugin/plugin.json', { name: 'commit-tools', description: 'Commits', author: { name: 'A' } });
  await write(root, 'commands/commit.md', '---\ndescription: Create a git commit\n---\nCommit it.');
  await write(root, 'skills/explain/SKILL.md', '---\nname: explain\ndescription: Explain code\n---\nBody');
  await write(root, '.mcp.json', { 'example-server': { type: 'http', url: 'https://mcp.example.com/api' } });
  await write(root, 'hooks/hooks.json', '{}');
  await write(root, 'agents/reviewer.md', 'agent');
  const result = await loadPlugin(root, { appVersion: '0.1.0', fallbackVersion: 'abc123def456' });
  assert.equal(result.format, 'claude');
  assert.equal(result.version, 'abc123def456');
  assert.deepEqual(result.contributes.prompts.map((p) => p.id), ['commit']);
  assert.deepEqual(result.contributes.skills.map((p) => p.id), ['explain']);
  assert.deepEqual(result.contributes.mcpServers.map((s) => s.name), ['example-server']);
  assert.deepEqual(result.contributes.commands, []);
  assert.deepEqual(result.unsupported.sort(), ['agents', 'hooks']);
});

test('marks plugins that need a newer app as incompatible', async (t) => {
  const root = await plugin(t, baseManifest({ minAppVersion: '0.2.0' }));
  assert.equal((await load(root, '0.1.0')).compatible, false);
  assert.equal((await load(root, '0.2.0')).compatible, true);
  assert.ok(compareVersions('1.0.0-beta', '1.0.0') < 0);
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
});

test('rejects themes with anything other than hex colours', async (t) => {
  const root = await plugin(
    t,
    baseManifest({ contributes: { themes: [{ id: 'bad', label: 'Bad', path: 'theme.json' }] } }),
    { 'theme.json': { base: 'graphite', colors: { chrome: 'url(https://evil)', stage: '#111111', well: '#111111', raised: '#111111', accent: '#111111', foreground: '#111111', muted: '#111111', selection: '#111111', keyword: '#111111', string: '#111111' } } },
  );
  await assert.rejects(load(root), /colour|color/i);
});

test('rejects plugins without a manifest or with broken JSON', async (t) => {
  const empty = await tempDir(t);
  await assert.rejects(load(empty), /manifest/i);
  const broken = await tempDir(t);
  await write(broken, '.veyo-plugin/plugin.json', '{ nope');
  await assert.rejects(load(broken), /JSON/);
});

// Files ----------------------------------------------------------------------

test('copyTree copies regular files and skips .git', async (t) => {
  const source = await tempDir(t);
  const target = path.join(await tempDir(t), 'copy');
  await write(source, 'a/b.txt', 'b');
  await write(source, '.git/HEAD', 'ref');
  await copyTree(source, target, { exclude: ['.git'] });
  assert.equal(await fs.readFile(path.join(target, 'a/b.txt'), 'utf8'), 'b');
  await assert.rejects(fs.stat(path.join(target, '.git')));
  const { files } = await scanTree(target);
  assert.deepEqual(files, ['a/b.txt']);
});

// Registry -------------------------------------------------------------------

const entry = (extra) => ({
  id: 'hello@local',
  name: 'hello',
  marketplace: 'local',
  scope: 'user',
  version: '1.0.0',
  source: { kind: 'local', path: 'C:/x' },
  installPath: 'C:/cache/local/hello/1.0.0',
  installedAt: '2026-10-08T00:00:00.000Z',
  lastUpdated: '2026-10-08T00:00:00.000Z',
  enabled: true,
  ...extra,
});

test('normalizeRegistry drops malformed entries', () => {
  const value = normalizeRegistry({
    version: 1,
    plugins: [entry(), { id: 'x' }, entry({ scope: 'project' }), entry({ name: 'Bad Name' }), null],
    marketplaces: [{ name: 'acme', source: { kind: 'local', path: 'C:/m' }, addedAt: 'x' }, { name: 'BAD' }],
  });
  assert.equal(value.plugins.length, 1);
  assert.equal(value.marketplaces.length, 1);
  assert.deepEqual(normalizeRegistry('garbage'), { version: 1, plugins: [], marketplaces: [] });
});

test('registry writes atomically and keeps the old state when a write fails', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'installed.json');
  let fail = false;
  const writeAtomic = async (target, json) => {
    if (fail) throw new Error('disk full');
    await fs.writeFile(`${target}.tmp`, json);
    await fs.rename(`${target}.tmp`, target);
  };
  const registry = createRegistry(file, writeAtomic);
  await registry.load();
  await Promise.all([
    registry.save((value) => value.plugins.push(entry())),
    registry.save((value) => value.plugins.push(entry({ id: 'other@local', name: 'other' }))),
  ]);
  assert.equal(registry.get().plugins.length, 2);
  fail = true;
  await assert.rejects(registry.save((value) => { value.plugins = []; }), /disk full/);
  assert.equal(registry.get().plugins.length, 2);
  const reloaded = createRegistry(file, writeAtomic);
  await reloaded.load();
  assert.equal(reloaded.get().plugins.length, 2);
});

test('scope resolution prefers project installs and falls back to user', () => {
  const user = entry();
  const projectInstall = entry({ scope: 'project', projectId: 'p1', version: '2.0.0' });
  const otherProject = entry({ id: 'x@local', name: 'x', scope: 'project', projectId: 'p2' });
  assert.deepEqual(activeEntries([user, projectInstall, otherProject], 'p1'), [projectInstall]);
  assert.deepEqual(activeEntries([user, projectInstall, otherProject], null), [user]);
  assert.deepEqual(activeEntries([user, { ...projectInstall, enabled: false }], 'p1'), [user]);
  assert.deepEqual(activeEntries([{ ...user, enabled: false }], 'p1'), []);
  assert.notEqual(entryKey(user), entryKey(projectInstall));
});

// Service: staging, install, enable/disable, uninstall ----------------------

const { createPluginService } = require('../electron/plugins/service.cjs');
const examples = path.resolve(__dirname, '../examples/marketplace/plugins');
async function writeAtomicForTest(target, json) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(`${target}.tmp`, json);
  await fs.rename(`${target}.tmp`, target);
}
async function service(t, extra = {}) {
  const dataDir = await tempDir(t, 'veyo plugins data ');
  let changes = 0;
  const value = createPluginService({ dataDir, appVersion: '0.1.0', writeAtomic: writeAtomicForTest, onChange: () => changes++, ...extra });
  await value.init();
  return { service: value, dataDir, changes: () => changes };
}

test('previewing a local plugin stages it without installing anything', async (t) => {
  const { service: plugins } = await service(t);
  const preview = await plugins.preview({ kind: 'local', path: path.join(examples, 'hello-veyo') });
  assert.equal(preview.id, 'hello-veyo@local');
  assert.equal(preview.plugin.contributes.commands.length, 2);
  assert.equal(preview.plugin.contributes.mcpServers[0].name, 'everything');
  assert.equal(preview.conflict, null);
  assert.deepEqual((await plugins.state()).plugins, []);
  assert.deepEqual((await plugins.contributions()).commands, []);
  await plugins.cancelPreview(preview.previewId);
  assert.deepEqual(await fs.readdir(plugins.paths.stagingDir), []);
});

test('install, disable, enable and uninstall change contributions immediately', async (t) => {
  const { service: plugins, changes } = await service(t);
  const preview = await plugins.preview({ kind: 'local', path: path.join(examples, 'hello-veyo') });
  const installed = await plugins.install(preview.previewId, 'user');
  assert.equal(changes(), 1);
  const [entry] = (await plugins.state()).plugins;
  assert.equal(entry.version, '1.0.0');
  assert.equal(entry.active, true);
  assert.ok(entry.source.path.endsWith('hello-veyo'));
  assert.ok(await fs.stat(path.join(plugins.paths.cacheDir, 'local', 'hello-veyo', '1.0.0', 'scripts', 'hello.mjs')));
  let contributions = await plugins.contributions('any-project');
  assert.deepEqual(contributions.commands.map((c) => c.key), ['hello-veyo:hello', 'hello-veyo:git-summary']);
  assert.deepEqual(contributions.agents.map((c) => c.key), ['hello-veyo:claude-sonnet']);
  assert.deepEqual(contributions.prompts.map((c) => c.key), ['hello-veyo:review-diff', 'hello-veyo:skill-explain-file']);
  assert.equal(contributions.themes[0].key, 'hello-veyo:dusk');
  const resolved = await plugins.resolve('any-project', 'commands', 'hello-veyo:hello');
  assert.equal(resolved.pluginRoot, entry.installPath ?? resolved.entry.installPath);

  await plugins.setEnabled(installed.key, false);
  contributions = await plugins.contributions('any-project');
  assert.deepEqual(contributions.commands, []);
  await assert.rejects(plugins.resolve('any-project', 'commands', 'hello-veyo:hello'), /not available/);
  await plugins.setEnabled(installed.key, true);
  assert.equal((await plugins.contributions()).commands.length, 2);

  const installPath = (await plugins.resolve(null, 'commands', 'hello-veyo:hello')).entry.installPath;
  await plugins.uninstall(installed.key);
  assert.deepEqual((await plugins.state()).plugins, []);
  assert.deepEqual((await plugins.contributions()).commands, []);
  await assert.rejects(fs.stat(installPath));
  assert.deepEqual(await fs.readdir(plugins.paths.cacheDir), []);
});

test('malicious example plugins are refused at preview with readable errors', async (t) => {
  const { service: plugins } = await service(t);
  await assert.rejects(plugins.preview({ kind: 'local', path: path.join(examples, 'evil-traversal') }), /inside the plugin folder/);
  await assert.rejects(plugins.preview({ kind: 'local', path: path.join(examples, 'evil-bypass') }), /approval/);
  await assert.rejects(plugins.preview({ kind: 'local', path: 'relative/path' }), /folder/);
  await assert.rejects(plugins.preview({ kind: 'local', path: await tempDir(t) }), /No plugin manifest/);
  await assert.rejects(plugins.preview({ kind: 'npm', name: 'x' }), /Unknown plugin source/);
  assert.deepEqual(await fs.readdir(plugins.paths.stagingDir), []);
});

test('an installed plugin edited on disk shows an error and contributes nothing', async (t) => {
  const { service: plugins } = await service(t);
  const preview = await plugins.preview({ kind: 'local', path: path.join(examples, 'hello-veyo') });
  await plugins.install(preview.previewId, 'user');
  const [entry] = (await plugins.state()).plugins;
  const installPath = (await plugins.resolve(null, 'commands', 'hello-veyo:hello')).entry.installPath;
  await fs.writeFile(path.join(installPath, '.veyo-plugin', 'plugin.json'), '{ broken');
  // A restart re-validates the files.
  const again = createPluginService({ dataDir: path.dirname(plugins.paths.root), appVersion: '0.1.0', writeAtomic: writeAtomicForTest });
  const state = await again.state();
  assert.match(state.plugins[0].error, /JSON/);
  assert.equal(state.plugins[0].active, false);
  assert.deepEqual((await again.contributions()).commands, []);
  assert.equal(entry.key, state.plugins[0].key);
});

test('start-up clears abandoned previews and keeps the registry', async (t) => {
  const { service: plugins, dataDir } = await service(t);
  const installedPreview = await plugins.preview({ kind: 'local', path: path.join(examples, 'hello-veyo') });
  await plugins.install(installedPreview.previewId, 'user');
  await plugins.preview({ kind: 'local', path: path.join(examples, 'hello-veyo') });
  assert.equal((await fs.readdir(plugins.paths.stagingDir)).length, 1);
  const restarted = createPluginService({ dataDir, appVersion: '0.1.0', writeAtomic: writeAtomicForTest });
  await restarted.init();
  assert.deepEqual(await fs.readdir(restarted.paths.stagingDir), []);
  assert.equal((await restarted.state()).plugins.length, 1);
});

test('start-up removes orphaned plugin folders, but not when the registry is unreadable', async (t) => {
  const { service: plugins, dataDir } = await service(t);
  await plugins.install((await plugins.preview({ kind: 'local', path: path.join(examples, 'hello-veyo') })).previewId, 'user');
  const [entry] = (await plugins.state()).plugins;
  const orphan = path.join(plugins.paths.cacheDir, 'local', 'old-plugin', '0.9.0');
  await write(orphan, 'file.txt', 'left behind');
  const restarted = createPluginService({ dataDir, appVersion: '0.1.0', writeAtomic: writeAtomicForTest });
  await restarted.init();
  await assert.rejects(fs.stat(orphan));
  assert.equal((await restarted.state()).plugins[0].key, entry.key);
  assert.ok((await restarted.contributions()).commands.length);

  await fs.writeFile(path.join(plugins.paths.root, 'installed.json'), '{ unreadable');
  const recovered = createPluginService({ dataDir, appVersion: '0.1.0', writeAtomic: writeAtomicForTest });
  assert.deepEqual((await recovered.state()).plugins, []);
  assert.ok(await fs.stat(path.join(plugins.paths.cacheDir, 'local', 'hello-veyo')), 'files are kept for recovery');
  assert.ok((await fs.readdir(plugins.paths.root)).some((name) => name.startsWith('installed.json.unreadable-')));
});

test('a disabled plugin cannot add its MCP servers', async (t) => {
  const { service: plugins } = await service(t);
  const { key } = await plugins.install((await plugins.preview({ kind: 'local', path: path.join(examples, 'hello-veyo') })).previewId, 'user');
  assert.equal((await plugins.mcpServer(key, 'everything')).server.command, 'npx');
  await plugins.setEnabled(key, false);
  await assert.rejects(plugins.mcpServer(key, 'everything'), /Enable the plugin/);
});

test('project installs apply only to their project and go away with it', async (t) => {
  const { service: plugins } = await service(t);
  const preview = await plugins.preview({ kind: 'local', path: path.join(examples, 'hello-veyo') });
  await plugins.install(preview.previewId, 'project', 'p1');
  assert.equal((await plugins.contributions('p1')).commands.length, 2);
  assert.equal((await plugins.contributions('p2')).commands.length, 0);
  await assert.rejects(plugins.install('missing', 'user'), /expired/);
  await plugins.forgetProject('p1');
  assert.deepEqual((await plugins.state()).plugins, []);
});

test('previewing an installed plugin again reports the update diff', async (t) => {
  const { service: plugins } = await service(t);
  const source = path.join(await tempDir(t), 'hello-veyo');
  await copyTree(path.join(examples, 'hello-veyo'), source);
  await plugins.install((await plugins.preview({ kind: 'local', path: source })).previewId, 'user');
  const manifestFile = path.join(source, '.veyo-plugin', 'plugin.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.version = '1.1.0';
  manifest.contributes.commands[1].run.args = ['log', '-1'];
  manifest.contributes.commands.push({ id: 'extra', title: 'Extra', run: { program: 'node', args: ['-v'] } });
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const update = await plugins.preview({ kind: 'local', path: source });
  assert.equal(update.update.fromVersion, '1.0.0');
  assert.equal(update.update.toVersion, '1.1.0');
  assert.deepEqual(update.update.commands, { added: ['extra'], removed: [], changed: ['git-summary'] });
  const [before] = (await plugins.state()).plugins;
  await plugins.install(update.previewId, 'user');
  const [after] = (await plugins.state()).plugins;
  assert.equal(after.version, '1.1.0');
  assert.equal(after.key, before.key);
  assert.deepEqual(await fs.readdir(path.join(plugins.paths.cacheDir, 'local', 'hello-veyo')), ['1.1.0']);
});

// Launching ------------------------------------------------------------------

const { buildLaunch } = require('../electron/plugins/launch.cjs');
const { programCommand, quotePowerShell } = require('../electron/terminal-command.cjs');

test('buildLaunch substitutes folders with spaces and quotes, and resolves PATH names', async (t) => {
  const pluginRoot = await tempDir(t, "veyo plugin it's ");
  await write(pluginRoot, 'run.ps1', 'Write-Output hi');
  const projectRoot = "C:\\work\\my project\\it's";
  const resolveProgram = async (name) => (name === 'node' ? 'C:\\Program Files\\nodejs\\node.exe' : null);
  const viaPath = await buildLaunch(
    { program: 'node', args: ['${pluginRoot}/x.mjs', '--root=${projectRoot}'] },
    { pluginRoot, projectRoot, resolveProgram, platform: 'win32' },
  );
  assert.equal(viaPath.executable, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(viaPath.args, [`${await fs.realpath(pluginRoot)}/x.mjs`, `--root=${projectRoot}`]);
  const script = await buildLaunch({ program: '${pluginRoot}/run.ps1', args: [] }, { pluginRoot, projectRoot, resolveProgram, platform: 'win32' });
  assert.equal(script.executable, path.join(await fs.realpath(pluginRoot), 'run.ps1'));
  await assert.rejects(buildLaunch({ program: 'missing-tool' }, { pluginRoot, projectRoot, resolveProgram }), /not found on PATH/);
  await assert.rejects(buildLaunch({ program: '${pluginRoot}/gone.ps1' }, { pluginRoot, projectRoot, resolveProgram }), /missing/);
});

test('buildLaunch refuses cmd scripts when a folder name brings in % or quotes', async (t) => {
  const pluginRoot = await tempDir(t);
  await write(pluginRoot, 'run.cmd', '@echo off');
  const options = { pluginRoot, resolveProgram: async () => null, platform: 'win32' };
  await assert.rejects(
    buildLaunch({ program: '${pluginRoot}/run.cmd', args: ['${projectRoot}'] }, { ...options, projectRoot: 'C:\\100%done' }),
    /cmd/,
  );
  const ok = await buildLaunch({ program: '${pluginRoot}/run.cmd', args: ['${projectRoot}'] }, { ...options, projectRoot: 'C:\\plain project' });
  assert.deepEqual(ok.args, ['C:\\plain project']);
  await write(pluginRoot, 'tool.mjs', '');
  await assert.rejects(buildLaunch({ program: '${pluginRoot}/tool.mjs' }, { ...options, projectRoot: 'C:\\p' }), /cannot be run directly/);
});

test('programCommand never lets an argument leave its quotes', () => {
  const direct = programCommand('C:\\tools\\node.exe', ['a b', "it's"], { platform: 'win32' });
  assert.deepEqual(direct, { command: 'C:\\tools\\node.exe', args: ['a b', "it's"] });
  const shell = programCommand('C:\\Users\\A B\\run.ps1', ["it's", 'x’; calc; ’y', '$(evil)'], { platform: 'win32', powershell: 'powershell.exe' });
  assert.equal(shell.command, 'powershell.exe');
  assert.equal(shell.args[3], "& 'C:\\Users\\A B\\run.ps1' 'it''s' 'x’’; calc; ’’y' '$(evil)'");
  assert.equal(quotePowerShell('‘'), "'‘‘'");
  const batch = programCommand('C:\\a b\\run.cmd', ['x y'], { platform: 'win32', comSpec: 'cmd.exe' });
  assert.equal(batch.args, '/d /s /c ""C:\\a b\\run.cmd" "x y""');
  assert.deepEqual(programCommand('/usr/bin/git', ['$(x)'], { platform: 'linux' }), { command: '/usr/bin/git', args: ['$(x)'] });
});

// Marketplaces ---------------------------------------------------------------

const { parseMarketplace, parseMarketplaceInput, isUpdateAvailable } = require('../electron/plugins/marketplace.cjs');
const { createGit, describeGitError, validateGitURL } = require('../electron/plugins/git.cjs');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const exampleMarketplace = path.resolve(__dirname, '../examples/marketplace');

test('parses Claude Code marketplace sources and keeps bad entries visible', () => {
  const value = parseMarketplace({
    name: 'acme',
    owner: { name: 'Acme' },
    plugins: [
      { name: 'local-one', source: './plugins/local-one', version: '1.2.0', category: 'Tools', tags: ['a'] },
      { name: 'from-url', source: { source: 'url', url: 'https://github.com/acme/x.git', sha: 'a'.repeat(40) } },
      { name: 'from-github', source: { source: 'github', repo: 'acme/y' } },
      { name: 'from-subdir', source: { source: 'git-subdir', url: 'https://github.com/acme/z.git', path: 'plugins/p', ref: 'v1.0' } },
      { name: 'from-npm', source: { source: 'npm', package: 'x' } },
      { name: 'escape', source: '../outside' },
      { name: 'Bad Name', source: './x' },
      { name: 'local-one', source: './again' },
      { name: 'helper', source: { source: 'url', url: 'ext::sh -c touch% /tmp/pwned' } },
    ],
  });
  assert.equal(value.name, 'acme');
  assert.equal(value.owner, 'Acme');
  const byName = Object.fromEntries(value.plugins.map((p, i) => [`${p.name}#${i}`, p]));
  assert.deepEqual(byName['local-one#0'].source, { type: 'relative', path: 'plugins/local-one' });
  assert.equal(byName['local-one#0'].category, 'tools');
  assert.equal(byName['from-url#1'].source.sha, 'a'.repeat(40));
  assert.equal(byName['from-github#2'].source.url, 'https://github.com/acme/y.git');
  assert.deepEqual(byName['from-subdir#3'].source, { type: 'git', url: 'https://github.com/acme/z.git', path: 'plugins/p', ref: 'v1.0' });
  assert.match(byName['from-npm#4'].error, /npm/);
  assert.match(byName['escape#5'].error, /inside/);
  assert.match(byName['Bad Name#6'].error, /lowercase/);
  assert.match(byName['local-one#7'].error, /more than once/);
  assert.ok(byName['helper#8'].error);
  assert.throws(() => parseMarketplace({ name: 'local', plugins: [] }), /reserved/);
  assert.throws(() => parseMarketplace({ name: 'x' }), /plugins list/);
});

test('marketplace input accepts Git addresses, owner/repo and folders only', () => {
  assert.deepEqual(parseMarketplaceInput('anthropics/claude-plugins-official'), { kind: 'git', url: 'https://github.com/anthropics/claude-plugins-official.git' });
  assert.deepEqual(parseMarketplaceInput('https://gitlab.com/a/b.git'), { kind: 'git', url: 'https://gitlab.com/a/b.git' });
  assert.deepEqual(parseMarketplaceInput('git@github.com:a/b.git'), { kind: 'git', url: 'git@github.com:a/b.git' });
  assert.equal(parseMarketplaceInput('C:\\market').kind, 'local');
  for (const bad of ['ext::sh -c id', 'file:///C:/x', '--upload-pack=calc', 'https://user:token@github.com/a/b', 'http://example.com/a.git', 'relative/../x/y', '']) assert.throws(() => parseMarketplaceInput(bad), undefined, bad);
  assert.throws(() => validateGitURL('https://github.com/a/b"; calc'));
});

test('update detection compares versions, then pinned commits', () => {
  assert.equal(isUpdateAvailable({ version: '1.0.0' }, { version: '1.1.0' }), true);
  assert.equal(isUpdateAvailable({ version: '1.1.0' }, { version: '1.0.0' }), false);
  assert.equal(isUpdateAvailable({ version: '1.0.0' }, { version: '1.0.0', sha: 'b'.repeat(40) }), false);
  assert.equal(isUpdateAvailable({ version: 'aaaaaaaaaaaa', sha: 'a'.repeat(40) }, { version: null, sha: 'b'.repeat(40) }), true);
  assert.equal(isUpdateAvailable({ version: 'aaaaaaaaaaaa', sha: 'a'.repeat(40) }, { version: null, sha: 'a'.repeat(40) }), false);
  assert.equal(isUpdateAvailable({ version: '1.0.0' }, null), false);
});

test('git errors become sentences a person can act on', () => {
  assert.match(describeGitError("fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com", 'https://github.com/a/b.git'), /Could not reach github.com/);
  assert.match(describeGitError('remote: Repository not found.', 'https://github.com/a/b.git'), /not found/);
  assert.match(describeGitError('fatal: could not read Username for', 'https://github.com/a/b.git'), /credentials/);
});

test('a local marketplace lists entries, installs from them and detects updates', async (t) => {
  const market = path.join(await tempDir(t), 'market');
  await copyTree(exampleMarketplace, market);
  const { service: plugins } = await service(t);
  const added = await plugins.addMarketplace(market);
  assert.equal(added.name, 'veyo-examples');
  await assert.rejects(plugins.addMarketplace(market), /already added/);
  let catalog = await plugins.catalog();
  assert.deepEqual(catalog.plugins.map((p) => p.name), ['hello-veyo', 'hello-prompts', 'evil-traversal', 'evil-bypass']);
  assert.equal(catalog.marketplaces[0].count, 4);

  const preview = await plugins.preview({ kind: 'marketplace', marketplace: 'veyo-examples', name: 'hello-veyo' });
  assert.equal(preview.id, 'hello-veyo@veyo-examples');
  assert.match(preview.source, /plugins\/hello-veyo$/);
  await plugins.install(preview.previewId, 'user');
  await assert.rejects(plugins.preview({ kind: 'marketplace', marketplace: 'veyo-examples', name: 'evil-bypass' }), /approval/);
  // The same plugin name from another source is refused at install.
  const local = await plugins.preview({ kind: 'local', path: path.join(market, 'plugins', 'hello-veyo') });
  assert.match(local.conflict, /Uninstall it first/);
  await assert.rejects(plugins.install(local.previewId, 'user'), /Uninstall it first/);

  catalog = await plugins.catalog();
  assert.equal(catalog.plugins[0].installed.length, 1);
  assert.equal(catalog.plugins[0].updateAvailable, false);
  const indexFile = path.join(market, '.veyo-plugin', 'marketplace.json');
  const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  index.plugins[0].version = '1.1.0';
  await fs.writeFile(indexFile, JSON.stringify(index));
  await plugins.refreshMarketplace('veyo-examples');
  assert.equal((await plugins.catalog()).plugins[0].updateAvailable, true);
  assert.equal((await plugins.state()).plugins[0].updateAvailable, true);

  await plugins.removeMarketplace('veyo-examples');
  assert.deepEqual((await plugins.catalog()).plugins, []);
  assert.equal((await plugins.state()).plugins.length, 1, 'installed plugins stay after removing their marketplace');
});

test('a marketplace entry name wins over the manifest name, as in Claude Code', async (t) => {
  const market = path.join(await tempDir(t), 'market');
  await copyTree(path.join(exampleMarketplace, 'plugins'), path.join(market, 'plugins'));
  await write(market, '.veyo-plugin/marketplace.json', { name: 'renamer', owner: { name: 'x' }, plugins: [{ name: 'listed-name', source: './plugins/hello-veyo' }] });
  const { service: plugins, dataDir } = await service(t);
  await plugins.addMarketplace(market);
  const preview = await plugins.preview({ kind: 'marketplace', marketplace: 'renamer', name: 'listed-name' });
  assert.equal(preview.id, 'listed-name@renamer');
  assert.equal(preview.plugin.manifestName, 'hello-veyo');
  await plugins.install(preview.previewId, 'user');
  assert.equal((await plugins.contributions()).commands[0].key, 'listed-name:hello');
  // After a restart the installed copy still loads under the listed name.
  const restarted = createPluginService({ dataDir, appVersion: '0.1.0', writeAtomic: writeAtomicForTest });
  const [entry] = (await restarted.state()).plugins;
  assert.equal(entry.error, undefined);
  assert.equal(entry.active, true);
});

test('a marketplace with a broken index reports the error instead of failing the catalog', async (t) => {
  const market = path.join(await tempDir(t), 'market');
  await copyTree(exampleMarketplace, market);
  const { service: plugins } = await service(t);
  await plugins.addMarketplace(market);
  await fs.writeFile(path.join(market, '.veyo-plugin', 'marketplace.json'), '{ broken');
  await plugins.refreshMarketplace('veyo-examples').catch(() => {});
  await plugins.registry.save((value) => {
    value.marketplaces[0].lastUpdated = new Date(Date.now() + 1000).toISOString();
  });
  const catalog = await plugins.catalog();
  assert.match(catalog.marketplaces[0].error, /JSON/);
  assert.deepEqual(catalog.plugins, []);
});

function gitRepo(dir) {
  const run = (...args) => execFileSync('git', ['-c', 'user.name=Veyo Test', '-c', 'user.email=test@veyo.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' }).toString().trim();
  run('init', '-q', '-b', 'main');
  run('add', '-A');
  run('commit', '-q', '-m', 'initial');
  return { head: run('rev-parse', 'HEAD'), run };
}

test('Git marketplaces and Git installs pin the commit sha', async (t) => {
  const repoDir = path.join(await tempDir(t), 'repo');
  await copyTree(exampleMarketplace, repoDir);
  const { head, run } = gitRepo(repoDir);
  const url = pathToFileURL(repoDir).href;
  const git = createGit({ allowFile: true });
  assert.equal(await git.available(), true);
  const { service: plugins } = await service(t, { git });
  const added = await plugins.addMarketplace(url);
  assert.equal(added.sha, head);
  const preview = await plugins.preview({ kind: 'marketplace', marketplace: 'veyo-examples', name: 'hello-veyo' });
  assert.equal(preview.sha, head);
  await plugins.install(preview.previewId, 'user');
  const [entry] = (await plugins.state()).plugins;
  assert.equal(entry.sha, head);

  // A new commit that changes the plugin without a version bump is an update by sha.
  const manifestFile = path.join(repoDir, 'plugins', 'hello-veyo', '.veyo-plugin', 'plugin.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.version = '1.0.1';
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  run('-c', 'user.name=T', '-c', 'user.email=t@t.invalid', 'commit', '-q', '-am', 'bump');
  await plugins.refreshMarketplace('veyo-examples');
  // The index still says 1.0.0, so the listed version wins and there is no update.
  assert.equal((await plugins.state()).plugins[0].updateAvailable, false);

  // Direct Git install of a plugin repository.
  const pluginRepo = path.join(await tempDir(t), 'plugin');
  await copyTree(path.join(exampleMarketplace, 'plugins', 'hello-veyo'), pluginRepo);
  const pluginHead = gitRepo(pluginRepo).head;
  await plugins.uninstall(entry.key);
  const direct = await plugins.preview({ kind: 'git', url: pathToFileURL(pluginRepo).href });
  assert.equal(direct.id, 'hello-veyo@git');
  assert.equal(direct.sha, pluginHead);
  await plugins.cancelPreview(direct.previewId);
  await assert.rejects(git.clone(url, path.join(await tempDir(t), 'x'), { sha: 'f'.repeat(40) }));
});

const { cliSupport, mcpAddArgs, mcpRemoveArgs } = require('../electron/plugins/mcp.cjs');

test('MCP servers are added through each CLI with the arguments in safe order', () => {
  const stdio = { name: 'docs', type: 'stdio', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js', '--port', '1'], env: { TOKEN: 'x' } };
  const base = { plugin: 'acme', scope: 'user', installPath: 'C:\\cache\\acme\\1.0.0' };
  assert.deepEqual(mcpAddArgs('claude', { ...base, server: stdio }).args, [
    'mcp', 'add', '--scope', 'user', 'acme-docs', '-e', 'TOKEN=x', '--', 'node', 'C:\\cache\\acme\\1.0.0/server.js', '--port', '1',
  ]);
  assert.equal(mcpAddArgs('claude', { ...base, scope: 'project', server: stdio }).args[3], 'local');
  const http = { name: 'remote', type: 'http', url: 'https://mcp.example.com', headers: { 'X-Key': 'abc' } };
  assert.deepEqual(mcpAddArgs('claude', { ...base, server: http }).args, ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'acme-remote', 'https://mcp.example.com', '-H', 'X-Key: abc']);
  assert.deepEqual(mcpAddArgs('codex', { ...base, server: stdio }).args, ['mcp', 'add', 'acme-docs', '--env', 'TOKEN=x', '--', 'node', 'C:\\cache\\acme\\1.0.0/server.js', '--port', '1']);
  assert.deepEqual(mcpAddArgs('codex', { ...base, server: { name: 'r', type: 'http', url: 'https://x.dev' } }).args, ['mcp', 'add', 'acme-r', '--url', 'https://x.dev']);
  assert.throws(() => mcpAddArgs('codex', { ...base, server: { ...http, type: 'sse' } }), /SSE/);
  assert.throws(() => mcpAddArgs('codex', { ...base, server: http }), /headers/);
  assert.throws(() => mcpAddArgs('gemini', { ...base, server: stdio }), /Choose/);
});

// Storefront ------------------------------------------------------------------

test('catalog listings carry sections, taglines and safe icon paths', () => {
  const value = parseMarketplace({
    name: 'store',
    plugins: [
      { name: 'one', source: './one', description: 'Manage and query databases. More detail follows here.', icon: 'icons/one.svg', iconDark: 'icons/one-dark.svg', setup: 'token', provider: 'Acme', displayName: 'One' },
      { name: 'two', source: './two', tagline: 'Short line', icon: '../outside.svg' },
      { name: 'three', source: './three', icon: 'icons/three.exe', setup: 'magic' },
      { name: 'broken', source: { source: 'npm', package: 'x' } },
    ],
    sections: [
      { id: 'popular', title: 'Popular', plugins: ['one', 'two', 'missing', 'broken', 'one'] },
      { id: 'Not Valid', title: 'X', plugins: ['one'] },
      { id: 'empty', title: 'Empty', plugins: ['missing'] },
    ],
  });
  const [one, two, three] = value.plugins;
  assert.equal(one.tagline, 'Manage and query databases.');
  assert.deepEqual([one.icon, one.iconDark, one.setup, one.provider, one.displayName], ['icons/one.svg', 'icons/one-dark.svg', 'token', 'Acme', 'One']);
  assert.equal(two.tagline, 'Short line');
  assert.equal(two.icon, null, 'icons may not leave the marketplace');
  assert.equal(three.icon, null, 'only svg, png and webp icons');
  assert.equal(three.setup, 'none');
  assert.deepEqual(value.sections, [{ id: 'popular', title: 'Popular', plugins: ['one', 'two'] }]);
});

test('MCP server auth is validated and never evaluates plugin patterns', async (t) => {
  const make = (auth) =>
    plugin(t, baseManifest({ contributes: { mcpServers: { svc: { type: 'http', url: 'https://mcp.example.com', auth } } } }));
  const ok = await load(await make({ type: 'env', variable: 'ACME_TOKEN', url: 'https://example.com/tokens', label: 'Acme token' }));
  assert.deepEqual(ok.contributes.mcpServers[0].auth, { type: 'env', variable: 'ACME_TOKEN', url: 'https://example.com/tokens', label: 'Acme token' });
  assert.deepEqual((await load(await make({ type: 'oauth' }))).contributes.mcpServers[0].auth, { type: 'oauth' });
  const client = await load(await make({ type: 'oauth-client', callbackPort: 8765, setupUrl: 'https://example.com/setup', clientIdPattern: '(a+)+$' }));
  assert.equal(client.contributes.mcpServers[0].auth.callbackPort, 8765);
  assert.equal(client.contributes.mcpServers[0].auth.clientIdPattern, undefined);
  for (const [auth, pattern] of [
    [{ type: 'env', variable: 'lower case' }, /environment variable/],
    [{ type: 'oauth-client', callbackPort: 80, setupUrl: 'https://x.dev' }, /port/],
    [{ type: 'oauth-client', callbackPort: 8765 }, /setupUrl/],
    [{ type: 'magic' }, /auth type/],
  ])
    await assert.rejects(load(await make(auth)), pattern);
  const stdio = await plugin(t, baseManifest({ contributes: { mcpServers: { svc: { command: 'node', auth: { type: 'oauth' } } } } }));
  await assert.rejects(load(stdio), /only to http/);
});

test('MCP add commands for token, sign-in and own-OAuth-client servers', () => {
  const base = { plugin: 'github', scope: 'user', installPath: 'C:\\p' };
  const github = { name: 'github', type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' }, auth: { type: 'env', variable: 'GITHUB_PERSONAL_ACCESS_TOKEN', url: 'https://github.com/settings/personal-access-tokens/new', label: 'token' } };
  const claude = mcpAddArgs('claude', { ...base, server: github });
  assert.equal(claude.name, 'github', 'a server named like its plugin keeps the plain name');
  assert.deepEqual(claude.args, ['mcp', 'add', '--transport', 'http', '--scope', 'user', 'github', 'https://api.githubcopilot.com/mcp/', '-H', 'Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}']);
  assert.equal(claude.followUp.kind, 'env');
  assert.deepEqual(mcpAddArgs('codex', { ...base, server: github }).args, ['mcp', 'add', 'github', '--url', 'https://api.githubcopilot.com/mcp/', '--bearer-token-env-var', 'GITHUB_PERSONAL_ACCESS_TOKEN']);

  const supabase = { name: 'supabase', type: 'http', url: 'https://mcp.supabase.com/mcp', auth: { type: 'oauth' } };
  const signIn = mcpAddArgs('codex', { ...base, plugin: 'supabase', server: supabase });
  assert.deepEqual(signIn.args, ['mcp', 'add', 'supabase', '--url', 'https://mcp.supabase.com/mcp']);
  assert.equal(signIn.followUp, null, 'Codex signs in while adding an OAuth server');
  assert.match(signIn.note, /opens your browser to sign in/);
  assert.deepEqual(mcpAddArgs('claude', { ...base, plugin: 'supabase', server: supabase }).followUp, { kind: 'login', args: ['mcp', 'login', 'supabase'] });

  const gmail = { name: 'gmail', type: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1', auth: { type: 'oauth-client', callbackPort: 8765, setupUrl: 'https://x.dev', clientIdHint: '' } };
  const own = mcpAddArgs('claude', { ...base, plugin: 'gmail', scope: 'project', server: gmail }, { clientId: ' 123-abc.apps.googleusercontent.com ' });
  assert.deepEqual(own.args, [
    'mcp', 'add', '--transport', 'http', '--scope', 'local', '--client-id', '123-abc.apps.googleusercontent.com', '--client-secret', '--callback-port', '8765', 'gmail', 'https://gmailmcp.googleapis.com/mcp/v1',
  ]);
  assert.match(own.note, /never sees it/);
  assert.throws(() => mcpAddArgs('claude', { ...base, plugin: 'gmail', server: gmail }), /client ID/);
  assert.throws(() => mcpAddArgs('claude', { ...base, plugin: 'gmail', server: gmail }, { clientId: 'x"; calc' }), /client ID/);
  assert.match(cliSupport('codex', gmail), /client secret/);
  assert.equal(cliSupport('claude', gmail), null);
  assert.deepEqual(mcpRemoveArgs('claude', 'gmail', 'project'), ['mcp', 'remove', 'gmail', '-s', 'local']);
  assert.deepEqual(mcpRemoveArgs('codex', 'gmail', 'user'), ['mcp', 'remove', 'gmail']);
  assert.throws(() => mcpRemoveArgs('codex', '../x', 'user'));
});

test('the built-in catalog is added on first browse, cannot be removed, and serves icons', async (t) => {
  const market = path.join(await tempDir(t), 'market');
  await copyTree(exampleMarketplace, market);
  await write(market, 'icons/huge.png', Buffer.alloc(300 * 1024).toString());
  const index = JSON.parse(await fs.readFile(path.join(market, '.veyo-plugin', 'marketplace.json'), 'utf8'));
  index.plugins[1].icon = 'icons/huge.png';
  await fs.writeFile(path.join(market, '.veyo-plugin', 'marketplace.json'), JSON.stringify(index));
  const { service: plugins } = await service(t, { publicCatalog: market });
  assert.deepEqual((await plugins.state()).marketplaces, [], 'nothing is fetched before browsing');
  const catalog = await plugins.catalog();
  assert.equal(catalog.publicName, 'veyo-examples');
  assert.equal(catalog.marketplaces[0].builtin, true);
  assert.deepEqual(catalog.marketplaces[0].sections.map((s) => s.title), ['Popular']);
  const hello = catalog.plugins.find((p) => p.name === 'hello-veyo');
  assert.match(hello.icon, /^data:image\/svg\+xml;base64,/);
  assert.equal(hello.displayName, 'Hello Veyo');
  assert.equal(catalog.plugins.find((p) => p.name === 'hello-prompts').icon, null, 'oversized icons fall back to a monogram');
  await assert.rejects(plugins.removeMarketplace('veyo-examples'), /built in/);
  await plugins.refreshPublic();
  assert.equal((await plugins.catalog()).marketplaces.length, 1);
});

test('the built-in catalog adopts a marketplace the person already added', async (t) => {
  const market = path.join(await tempDir(t), 'market');
  await copyTree(exampleMarketplace, market);
  const { service: plugins, dataDir } = await service(t);
  await plugins.addMarketplace(market);
  const later = createPluginService({ dataDir, appVersion: '0.1.0', writeAtomic: writeAtomicForTest, publicCatalog: market });
  const catalog = await later.catalog();
  assert.equal(catalog.marketplaces.length, 1);
  assert.equal(catalog.marketplaces[0].builtin, true);
});

test('an unreachable built-in catalog is reported and retried', async (t) => {
  const { service: plugins } = await service(t, { publicCatalog: path.join(os.tmpdir(), 'veyo-no-such-catalog') });
  const catalog = await plugins.catalog();
  assert.equal(catalog.publicName, null);
  assert.match(catalog.publicError, /not found/);
  await assert.rejects(plugins.refreshPublic(), /not found/);
});

test('previews say whether a plugin can run anything', async (t) => {
  const { service: plugins } = await service(t);
  const prompts = await plugins.preview({ kind: 'local', path: path.join(examples, 'hello-prompts') });
  assert.equal(prompts.risk, 'none');
  const runs = await plugins.preview({ kind: 'local', path: path.join(examples, 'hello-veyo') });
  assert.equal(runs.risk, 'runs');
  const planned = await plugins.previewMcpServer(runs.previewId, 'everything', 'project');
  assert.equal(planned.scope, 'project');
  assert.equal(planned.installPath, '<plugin folder>');
  await assert.rejects(plugins.previewMcpServer('nope', 'everything'), /expired/);
});

test('MCP connections are recorded, kept across updates and forgotten', async (t) => {
  const { service: plugins } = await service(t);
  const source = path.join(await tempDir(t), 'hello-veyo');
  await copyTree(path.join(examples, 'hello-veyo'), source);
  const { key } = await plugins.install((await plugins.preview({ kind: 'local', path: source })).previewId, 'user');
  await plugins.recordConnection(key, { cli: 'claude', name: 'hello-veyo-everything', server: 'everything', scope: 'user' });
  await plugins.recordConnection(key, { cli: 'claude', name: 'hello-veyo-everything', server: 'everything', scope: 'user' });
  assert.equal((await plugins.connectionsOf(key)).length, 1, 'recording twice keeps one');
  const manifestFile = path.join(source, '.veyo-plugin', 'plugin.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.version = '1.0.1';
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await plugins.install((await plugins.preview({ kind: 'local', path: source })).previewId, 'user');
  assert.equal((await plugins.state()).plugins[0].connections[0].cli, 'claude', 'updates keep connections');
  await plugins.forgetConnection(key, 'claude', 'hello-veyo-everything');
  assert.deepEqual(await plugins.connectionsOf(key), []);
});

test('the public catalog override is ignored in packaged builds', () => {
  const { PUBLIC_CATALOG, publicCatalogSource } = require('../electron/plugins/public.cjs');
  assert.equal(publicCatalogSource(true, 'C:\\evil'), PUBLIC_CATALOG);
  assert.equal(publicCatalogSource(false, 'relative/path'), PUBLIC_CATALOG);
  assert.equal(publicCatalogSource(false, path.resolve('examples/marketplace')), path.resolve('examples/marketplace'));
  assert.equal(PUBLIC_CATALOG, 'https://github.com/Aamirazmy92/veyo-plugins.git');
});

test('the storefront lists curated sections, then every valid plugin', () => {
  const { storefrontSections, monogram } = require('../src/pluginModel.ts');
  const entry = (name, extra = {}) => ({ name, displayName: name.toUpperCase(), marketplace: 'store', error: null, ...extra });
  const catalog = {
    marketplaces: [{ name: 'store', builtin: true, sections: [{ id: 'popular', title: 'Popular', plugins: ['b', 'gone'] }] }, { name: 'mine', sections: [] }],
    plugins: [entry('b'), entry('a'), entry('bad', { error: 'nope' }), entry('x', { marketplace: 'mine' })],
  };
  const sections = storefrontSections(catalog, 'store');
  assert.deepEqual(sections.map((s) => [s.title, s.entries.map((e) => e.name)]), [['Popular', ['b']], ['All plugins', ['a', 'b']]]);
  assert.deepEqual(storefrontSections(catalog, null), []);
  assert.equal(monogram('google-drive').letters, 'GD');
  assert.equal(monogram('github').letters, 'GI');
  assert.equal(monogram('x').hue, monogram('x').hue);
});

test('missing git is reported, not thrown as a crash', async (t) => {
  const git = createGit({ command: 'veyo-no-such-git-command' });
  assert.equal(await git.available(), false);
  const { service: plugins } = await service(t, { git });
  await assert.rejects(plugins.addMarketplace('https://github.com/a/b.git'), /Git is not installed/);
  assert.equal((await plugins.catalog()).gitAvailable, false);
});
