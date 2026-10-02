const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp-settings-'));
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [path.resolve('.')],
    env: { ...process.env, SUPERAPP_DATA_DIR: dataDir },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.waitFor();
    await page.getByRole('button', { name: /Midnight Cool blue tones/ }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'midnight');
    assert.equal(await page.locator('.app').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(12, 18, 32)');
    await page.screenshot({ path: 'output/playwright/settings-appearance.png' });
    await page.getByRole('button', { name: 'Editor', exact: true }).click();
    await page.getByLabel('Font size', { exact: false }).selectOption('16');
    await page.getByRole('switch', { name: 'Word wrap' }).check();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.getByLabel('Terminal font size').selectOption('18');
    await page.getByRole('switch', { name: 'Blinking cursor' }).uncheck();
    await page.getByLabel(/Terminal font(?! size)/).selectOption('Consolas');
    if (process.platform === 'win32') await page.getByLabel('Default shell').selectOption('cmd');
    await dialog.getByRole('button', { name: 'Editor', exact: true }).click();
    await page.getByLabel('Font family').selectOption('JetBrains Mono');
    assert.match(
      await page.locator('.preferences-preview pre').evaluate((el) => getComputedStyle(el).fontFamily),
      /^"JetBrains Mono"/,
    );
    await dialog.getByRole('button', { name: 'General', exact: true }).click();
    await page.getByLabel('On startup').selectOption('none');
    await dialog.getByRole('button', { name: 'Chat', exact: true }).click();
    await page.getByLabel('Default provider').selectOption('claude');
    await page.getByLabel('Default permissions').selectOption('auto');
    assert.equal(await page.getByLabel('Default permissions').locator('option[value="full"]').count(), 0);
    await dialog.getByRole('button', { name: 'Notifications', exact: true }).click();
    await page.getByLabel('Warning threshold').selectOption('60');
    await page.getByLabel('Critical threshold').selectOption('95');
    await page.getByRole('switch', { name: 'Usage alerts' }).uncheck();
    assert.equal(await page.getByLabel('Warning threshold').isDisabled(), true);
    await page.screenshot({ path: 'output/playwright/settings-notifications.png' });
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    assert.equal(
      await page
        .getByRole('button', { name: 'Settings', exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'midnight');
    assert.equal(await page.getByRole('button', { name: /Midnight Cool blue tones/ }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Editor', exact: true }).click();
    assert.equal(await page.getByLabel('Font size', { exact: false }).inputValue(), '16');
    assert.equal(await page.getByRole('switch', { name: 'Word wrap' }).isChecked(), true);
    assert.equal(await page.getByLabel('Font family').inputValue(), 'JetBrains Mono');
    await page.screenshot({ path: 'output/playwright/settings-updated.png' });
    const saved = JSON.parse(
      await page.evaluate(() => localStorage.getItem('superapp.preferences.v1')),
    );
    assert.deepEqual(
      {
        terminalFontFamily: saved.terminalFontFamily,
        startup: saved.startup,
        chatProvider: saved.chatProvider,
        chatPermission: saved.chatPermission,
        usageAlerts: saved.usageAlerts,
        usageWarningAt: saved.usageWarningAt,
        usageCriticalAt: saved.usageCriticalAt,
      },
      {
        terminalFontFamily: 'Consolas',
        startup: 'none',
        chatProvider: 'claude',
        chatPermission: 'auto',
        usageAlerts: false,
        usageWarningAt: 60,
        usageCriticalAt: 95,
      },
    );
    if (process.platform === 'win32') {
      await dialog.getByRole('button', { name: 'Terminal', exact: true }).click();
      assert.equal(await page.getByLabel('Default shell').inputValue(), 'cmd');
      await dialog.getByRole('button', { name: 'Editor', exact: true }).click();
    }
    await page.getByLabel('Search settings').fill('scrollback');
    assert.equal(await page.getByLabel('Scrollback').count(), 1);
    await page.getByLabel('Search settings').fill('');
    await page.getByRole('button', { name: 'Restore defaults' }).click();
    await page.getByRole('button', { name: 'Confirm reset' }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'graphite');
    assert.equal(await page.getByLabel('Font size', { exact: false }).inputValue(), '12');
    await page.getByRole('button', { name: 'Close settings', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(
      await page
        .getByRole('button', { name: 'Restore defaults' })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 2000 });
    console.log(
      'Settings: persistence, search, reset, focus trap, focus restoration and Escape passed.',
    );
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
