const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// Run after npm run build: node tests/chat-model-menu.electron.cjs
// The model button and its menu: models, the Effort flyout and "More models"
// can all be chosen with the mouse and the keyboard. The model list is a stub.
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-model-menu-'));
  const projectRoot = path.join(dataDir, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(
    path.join(dataDir, 'workspaces.json'),
    JSON.stringify({ projects: [{ id: 'p', name: 'P', root: projectRoot }], activeProject: 'p', sessions: {} }),
  );
  const thread = {
    id: 't', title: 'New chat', provider: 'claude', model: 'sonnet', permission: 'ask',
    projectId: 'p', messages: [], draft: '', updatedAt: Date.now(),
  };
  await fs.writeFile(
    path.join(dataDir, 'chats.json'),
    JSON.stringify({ threads: [thread], active: 't', settings: { provider: 'claude', model: 'sonnet' } }),
  );
  const env = { ...process.env, VEYO_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VEYO_DEV_URL;
  const app = await _electron.launch({ executablePath: require('electron'), args: [path.resolve('.')], env });
  try {
    const page = await app.firstWindow();
    await page.locator('.app').waitFor();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('chat:models');
      const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
      ipcMain.handle('chat:models', async () => [
        { id: 'default', name: 'Default', efforts, defaultEffort: 'medium', isDefault: true },
        { id: 'opus', name: 'Opus 5.5', efforts, defaultEffort: 'medium' },
        { id: 'sonnet', name: 'Sonnet 5.5', efforts, defaultEffort: 'medium' },
        { id: 'fable', name: 'Fable 5.1', efforts, defaultEffort: 'medium' },
        { id: 'haiku', name: 'Haiku 5.5', efforts, defaultEffort: 'medium' },
        { id: 'old', name: 'Opus 4.8', efforts, defaultEffort: 'medium' },
      ]);
    });
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh chat models' }).click({ force: true });
    const picker = page.getByRole('combobox', { name: 'Chat model' });
    const shown = async () => (await picker.innerText()).replace(/\s+/g, ' ').trim();
    const settle = () => page.waitForTimeout(250);
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Chat model"]')?.textContent?.includes('Sonnet 5.5'),
    );
    assert.equal(await shown(), 'Sonnet 5.5 Medium');

    // Choosing a model with the mouse.
    await picker.click();
    await page.getByRole('option', { name: /^Opus 5.5/ }).click();
    await settle();
    assert.equal(await shown(), 'Opus 5.5 Medium');

    // Choosing an effort level from the flyout: a click inside the flyout must
    // not count as a click outside the menu.
    await picker.click();
    await page.getByRole('option', { name: /^Effort/ }).hover();
    const effortMenu = page.getByRole('listbox', { name: 'Reasoning effort' });
    await effortMenu.getByRole('option', { name: /^High/ }).click();
    await settle();
    assert.equal(await shown(), 'Opus 5.5 High');
    await picker.click();
    await page.getByRole('option', { name: /^Effort/ }).hover();
    assert.equal(
      await effortMenu.getByRole('option', { name: /^High/ }).getAttribute('aria-selected'),
      'true',
    );
    await page.keyboard.press('Escape');

    // Choosing from "More models" in the same way.
    await picker.click();
    await page.getByRole('option', { name: /^More models/ }).hover();
    const moreMenu = page.getByRole('listbox', { name: 'More models' });
    await moreMenu.getByRole('option', { name: /^Opus 4\.8/ }).click();
    await settle();
    assert.match(await shown(), /^Opus 4\.8 /);

    // The keyboard reaches the flyout (Medium is current, so one step down is High).
    await picker.focus();
    await page.keyboard.press('ArrowDown');
    const effortRow = page.getByRole('option', { name: /^Effort/ });
    await effortRow.waitFor();
    for (let i = 0; i < 20; i++) {
      if ((await effortRow.getAttribute('class')).includes('highlight')) break;
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await settle();
    assert.equal(await shown(), 'Opus 4.8 High');
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
