const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-updates-'));
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [path.resolve('.')],
    env: { ...process.env, VEYO_DATA_DIR: dataDir },
  });
  try {
    const page = await app.firstWindow();
    const send = (state) =>
      app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('update:state', value), state);
    const base = { version: '0.1.0', supported: true };
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Update to Veyo/ }).count(), 0);

    await send({ ...base, status: 'downloading', latest: '0.2.0', percent: 40 });
    const downloading = page.getByRole('button', { name: /Downloading Veyo 0.2.0/ });
    await downloading.waitFor();
    assert.equal(await downloading.isDisabled(), true);

    await send({ ...base, status: 'ready', latest: '0.2.0', percent: 100, checkedAt: Date.now() });
    const button = page.getByRole('button', { name: 'Update to Veyo 0.2.0' });
    await button.waitFor();
    await page.getByText('Veyo 0.2.0 is ready to install.').first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Restart to update' }).count(), 1);
    await page.screenshot({ path: 'output/playwright/update-ready.png' });

    await button.click();
    const popover = page.getByRole('dialog', { name: 'Install update' });
    await popover.waitFor();
    await page.screenshot({ path: 'output/playwright/update-popover.png' });
    await popover.getByRole('button', { name: 'Later' }).click();
    await popover.waitFor({ state: 'detached' });

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.getByRole('button', { name: 'Updates', exact: true }).click();
    // Settings reads the updater's real state when it opens; send the simulated one again.
    await send({ ...base, status: 'ready', latest: '0.2.0', percent: 100, checkedAt: Date.now() });
    await dialog.getByText('Veyo 0.2.0 is ready').first().waitFor();
    await page.screenshot({ path: 'output/playwright/update-settings.png' });
    assert.equal(await dialog.getByRole('button', { name: 'Restart to update' }).count(), 1);
    await page.screenshot({ path: 'output/playwright/update-settings.png' });
    await page.getByLabel('Search settings').fill('upgrade');
    assert.equal(await dialog.getByRole('button', { name: 'Restart to update' }).count(), 1);

    await send({ ...base, status: 'current', checkedAt: Date.now() });
    await page.getByLabel('Search settings').fill('');
    await dialog.getByText(/latest version/).first().waitFor();
    assert.equal(await page.getByRole('button', { name: /Update to Veyo/ }).count(), 0);
    console.log('Updates: title bar button, prompt, notification and Settings section passed.');
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
