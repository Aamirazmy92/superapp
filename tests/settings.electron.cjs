const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-settings-'));
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [path.resolve('.')],
    env: { ...process.env, VEYO_DATA_DIR: dataDir },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.waitFor();
    await page.getByRole('button', { name: /Linen Soft paper tones/ }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.screenshot({ path: 'output/playwright/settings-appearance.png' });
    await page.getByRole('button', { name: 'Editor', exact: true }).click();
    const pick = async (name, option) => {
      await page.getByRole('combobox', { name, exact: true }).click();
      await page.getByRole('option', { name: option, exact: true }).click();
    };
    await pick('Font size', '16 px');
    await page.getByRole('switch', { name: 'Word wrap' }).check();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await pick('Terminal font size', '18 px');
    await page.getByRole('switch', { name: 'Blinking cursor' }).uncheck();
    await pick('Terminal font', 'Consolas');
    if (process.platform === 'win32') await pick('Default shell', /Command Prompt|cmd/i);
    await dialog.getByRole('button', { name: 'Editor', exact: true }).click();
    await pick('Font family', 'JetBrains Mono');
    assert.match(
      await page.locator('.preferences-preview pre').evaluate((el) => getComputedStyle(el).fontFamily),
      /^"JetBrains Mono"/,
    );
    await dialog.getByRole('button', { name: 'General', exact: true }).click();
    await pick('On startup', 'Start with no project open');
    await dialog.getByRole('button', { name: 'Chat', exact: true }).click();
    await pick('Default provider', 'Claude Code');
    await pick('Default permissions', 'Approve safe actions');
    await page.getByRole('combobox', { name: 'Default permissions' }).click();
    assert.equal(await page.getByRole('option', { name: /full/i }).count(), 0);
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Notifications', exact: true }).click();
    await pick('Warning threshold', '60%');
    await pick('Critical threshold', '95%');
    await page.getByRole('switch', { name: 'Usage alerts' }).uncheck();
    assert.equal(await page.getByRole('combobox', { name: 'Warning threshold' }).isDisabled(), true);
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
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.getByRole('button', { name: /Linen Soft paper tones/ }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Editor', exact: true }).click();
    assert.equal((await page.getByRole('combobox', { name: 'Font size', exact: true }).innerText()).trim(), '16 px');
    assert.equal(await page.getByRole('switch', { name: 'Word wrap' }).isChecked(), true);
    assert.equal((await page.getByRole('combobox', { name: 'Font family', exact: true }).innerText()).trim(), 'JetBrains Mono');
    await page.screenshot({ path: 'output/playwright/settings-updated.png' });
    const saved = JSON.parse(
      await page.evaluate(() => localStorage.getItem('veyo.preferences.v1')),
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
      assert.match(await page.getByRole('combobox', { name: 'Default shell', exact: true }).innerText(), /cmd|command prompt/i);
      await dialog.getByRole('button', { name: 'Editor', exact: true }).click();
    }
    await page.getByLabel('Search settings').fill('scrollback');
    assert.equal(await page.getByLabel('Scrollback').count(), 1);
    await page.getByLabel('Search settings').fill('');
    await page.getByRole('button', { name: 'Restore defaults' }).click();
    await page.getByRole('button', { name: 'Confirm reset' }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'graphite');
    assert.equal((await page.getByRole('combobox', { name: 'Font size', exact: true }).innerText()).trim(), '12 px');
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
