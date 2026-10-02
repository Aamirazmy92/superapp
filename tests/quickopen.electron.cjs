const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// Run after npm run build: node tests/quickopen.electron.cjs
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp-quickopen-'));
  const root = path.join(dataDir, 'project');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
  await fs.writeFile(path.join(root, 'src', 'beta.ts'), 'export const beta = 2;\n');
  await fs.writeFile(
    path.join(dataDir, 'workspaces.json'),
    JSON.stringify({
      projects: [{ id: 'quick-open', name: 'Quick open', root }],
      activeProject: 'quick-open',
      sessions: {},
    }),
  );
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [path.resolve('.')],
    env: { ...process.env, SUPERAPP_DATA_DIR: dataDir },
  });
  try {
    const page = await app.firstWindow();
    await page.locator('.app').waitFor();
    await page.locator('.project-row').first().waitFor();
    await page.keyboard.press('Control+p');
    const dialog = page.getByRole('dialog', { name: 'Quick open file' });
    await dialog.waitFor();
    await page.getByLabel('Find file by name or path').fill('beta');
    await dialog.getByRole('button', { name: /beta\.ts/ }).waitFor();
    await fs.mkdir(path.join('output', 'playwright'), { recursive: true });
    await page.screenshot({ path: 'output/playwright/quick-open.png' });
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    await page.locator('.file-breadcrumb').getByText('src / beta.ts').waitFor();
    await page.getByRole('button', { name: 'Ask chat' }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    assert.match(
      await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(),
      /Help me with src\/beta\.ts/,
    );
    assert.equal(await page.getByLabel('Include src/beta.ts with each request').isChecked(), true);
    await page.getByRole('button', { name: 'Code', exact: true }).click();
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('Control+a');
    await page.getByRole('button', { name: 'Ask chat' }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    assert.match(
      await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(),
      /export const beta = 2/,
    );
    assert.equal(await page.getByLabel('Include src/beta.ts with each request').isChecked(), false);
    await page.getByRole('button', { name: 'Code', exact: true }).click();
    await page.keyboard.press('Control+p');
    assert.equal(await dialog.getByText('Open files').count(), 1);
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'Command palette' }).waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+p');
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    console.log('Quick open navigation and editor-to-chat handoff passed.');
  } finally {
    await app.close();
    if (
      !path.resolve(dataDir).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
      !path.basename(dataDir).startsWith('superapp-quickopen-')
    )
      throw new Error('Refusing to remove a directory outside the test profile.');
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
