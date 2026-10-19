// The first Claude chat in a project that brings its own Claude settings asks
// whether to trust them, and the answer is kept for the project. `claude` is
// left off PATH, so nothing is launched: the prompt comes before any request.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-trust-'));
  const projectRoot = path.join(dataDir, 'project');
  let app;
  try {
    await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.claude', 'settings.json'), '{"hooks":{}}');
    await fs.writeFile(path.join(projectRoot, 'CLAUDE.md'), 'Project rules');
    await fs.writeFile(path.join(dataDir, 'workspaces.json'), JSON.stringify({
      projects: [{ id: 'trust-fixture', name: 'Trust fixture', root: projectRoot }],
      activeProject: 'trust-fixture', sessions: {},
    }));
    const thread = {
      id: 'trust-thread', title: 'New chat', provider: 'claude', model: 'default', permission: 'ask',
      projectId: 'trust-fixture', messages: [], draft: 'Hello', updatedAt: Date.now(),
    };
    await fs.writeFile(path.join(dataDir, 'chats.json'), JSON.stringify({
      threads: [thread], active: thread.id, settings: { provider: 'claude', model: 'default' },
    }));
    const env = { ...process.env, VEYO_DATA_DIR: dataDir };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    env[pathKey] = [path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter);
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VEYO_DEV_URL;
    app = await _electron.launch({ executablePath: require('electron'), args: [path.resolve('.')], env });
    const page = await app.firstWindow();
    await page.locator('.app').waitFor();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    await message.waitFor();
    const dialog = page.getByRole('dialog', { name: /Trust this project/ });
    const saved = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'workspaces.json'), 'utf8')).projects[0].claudeSettings;

    // Closing the prompt sends nothing and decides nothing.
    await message.press('Enter');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /\.claude, CLAUDE\.md/);
    await fs.mkdir(path.join('output', 'playwright'), { recursive: true });
    await page.screenshot({ path: 'output/playwright/chat-trust-prompt.png' });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await message.inputValue(), 'Hello');
    assert.equal(await saved(), undefined);

    // "Don't trust" is remembered and the message goes ahead.
    await message.press('Enter');
    await dialog.getByRole('button', { name: 'Don’t trust' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await saved(), 'ignored');
    assert.deepEqual(
      await page.evaluate(() => window.workspace.claudeSettings('trust-fixture')),
      { decision: 'ignored', files: ['.claude', 'CLAUDE.md'] },
    );
    // The renderer cannot choose a decision other than the two offered.
    await assert.rejects(page.evaluate(() => window.workspace.setClaudeSettings('trust-fixture', 'yes')));
    console.log('PASS: Claude chat asks once before loading a project\'s own settings');
  } finally {
    await app?.close().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
