const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// Run after npm run build: node tests/chat-groups.electron.cjs
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-chat-groups-'));
  const projectDir = path.join(dataDir, 'groups-project');
  await fs.mkdir(projectDir);
  const launch = () =>
    _electron.launch({
      executablePath: require('electron'),
      args: [path.resolve('.'), `--project=${projectDir}`],
      env: { ...process.env, VEYO_DATA_DIR: dataDir },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.locator('.app').waitFor();
    const { projects } = await page.evaluate(() => window.workspace.bootstrap());
    const project = projects.find((p) => path.resolve(p.root) === path.resolve(projectDir)) ?? projects[0];
    assert.ok(project, 'the launched project is listed');
    const now = Date.now();
    const chat = (id, title, projectId, updatedAt) => ({
      id, title, projectId, updatedAt, draft: '',
      messages: [{ role: 'user', content: title }],
    });
    await page.evaluate((threads) => window.workspace.saveChatState({ threads, active: null, settings: {} }), [
      chat('general-1', 'General question', '', now - 2000),
      chat('project-1', 'Project question', project.id, now - 1000),
      chat('project-2', 'Older project question', project.id, now - 5000),
      chat('removed-1', 'Removed project question', 'gone-project', now - 3000),
    ]);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.locator('.app').waitFor();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();

    const list = () => page.getByRole('navigation', { name: 'Conversations' });
    const group = (name) => list().getByRole('region', { name, exact: true });
    const toggle = (name) => group(name).locator('.chat-group-toggle');
    const titles = (name) => group(name).locator('.chat-thread-open span').allTextContents();
    await group('General').waitFor();
    // General first, then projects; chats of a removed project count as General.
    assert.deepEqual(await list().locator('.chat-thread-group').evaluateAll((sections) => sections.map((s) => s.getAttribute('aria-label'))),
      ['General', project.name]);
    assert.deepEqual(await titles('General'), ['General question', 'Removed project question']);
    assert.deepEqual(await titles(project.name), ['Project question', 'Older project question']);

    // Minimising hides a group's chats and is remembered after a restart.
    await toggle(project.name).click();
    assert.equal(await toggle(project.name).getAttribute('aria-expanded'), 'false');
    assert.equal(await group(project.name).locator('.chat-thread').count(), 0);
    await page.screenshot({ path: 'output/playwright/chat-groups-minimised.png' });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.locator('.app').waitFor();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await group('General').waitFor();
    assert.equal(await toggle(project.name).getAttribute('aria-expanded'), 'false');

    // Searching shows matches even in minimised groups.
    await page.getByRole('textbox', { name: 'Search chats' }).fill('older');
    assert.deepEqual(await titles(project.name), ['Older project question']);
    assert.equal(await group('General').count(), 0);
    await page.getByRole('button', { name: 'Clear search' }).click();
    assert.equal(await group(project.name).locator('.chat-thread').count(), 0);

    // A new chat from a group's header belongs to that group's project.
    await group('General').hover();
    await group('General').getByRole('button', { name: 'Start chat in General' }).click();
    assert.deepEqual(await titles('General'), ['Untitled chat', 'General question', 'Removed project question']);
    assert.equal(await page.getByRole('combobox', { name: 'Chat project' }).textContent().then((t) => /No project/.test(t)), true);
    await group(project.name).hover();
    await group(project.name).getByRole('button', { name: `Start chat in ${project.name}` }).click();
    // The empty chat moves rather than leaving another untitled chat behind.
    assert.deepEqual(await titles('General'), ['General question', 'Removed project question']);
    assert.equal(await toggle(project.name).getAttribute('aria-expanded'), 'true', 'the new chat\'s group opens');
    assert.equal((await titles(project.name))[0], 'Untitled chat');
    await page.screenshot({ path: 'output/playwright/chat-groups.png' });
    console.log('Chat groups by project, minimising, search and per-group new chats passed.');
  } finally {
    await app?.close();
    if (!path.resolve(dataDir).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
        !path.basename(dataDir).startsWith('veyo-chat-groups-'))
      throw new Error('Refusing to remove a directory outside the test profile.');
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
