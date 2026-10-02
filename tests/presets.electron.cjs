const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp-presets-'));
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp-project-'));
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [path.resolve('.'), `--project=${projectDir}`],
    env: { ...process.env, SUPERAPP_DATA_DIR: dataDir },
  });
  try {
    const page = await app.firstWindow();
    const composer = page.locator('.home-composer');
    await page.locator('.home-agent-tiles .home-tile').first().waitFor();
    // No presets yet: no Quick start row, but saving is offered next to Launch.
    assert.equal(await page.getByRole('region', { name: 'Quick start' }).count(), 0);
    await page.screenshot({ path: 'output/playwright/presets-empty.png' });

    // Terminal ×2, then save.
    await page.locator('.home-agent-tiles').getByRole('button', { name: 'Terminal', exact: true }).click();
    const selectedOthers = page.locator('.home-agent-tiles .home-tile.selected', { hasNotText: 'Terminal' });
    while (await selectedOthers.count()) {
      await selectedOthers.first().locator('.home-tile-select').click();
    }
    await page.getByRole('button', { name: 'More Terminal sessions' }).click();
    await composer.getByRole('button', { name: 'Save as preset' }).click();
    await page.getByLabel('Preset name').fill('Two shells');
    await page.screenshot({ path: 'output/playwright/presets-naming.png' });
    await page.getByLabel('Preset name').press('Enter');
    const quick = page.getByRole('region', { name: 'Quick start' });
    await quick.waitFor();
    assert.match(await quick.innerText(), /Two shells/);
    assert.match(await composer.innerText(), /Two shells ·/);
    assert.equal(await composer.getByRole('button', { name: 'Save as preset' }).count(), 0);

    // Tweak the lineup: offer to save changes, prefilled, and update in place.
    await page.getByRole('button', { name: 'More Terminal sessions' }).click();
    await composer.getByRole('button', { name: 'Save changes' }).click();
    assert.equal(await page.getByLabel('Preset name').inputValue(), 'Two shells');
    assert.equal(await composer.getByRole('button', { name: 'Update preset' }).count(), 1);
    await page.getByLabel('Preset name').fill('Three shells');
    assert.equal(await composer.getByRole('button', { name: 'Save preset' }).count(), 1);
    await page.getByLabel('Preset name').fill('two shells');
    await composer.getByRole('button', { name: 'Update preset' }).click();
    await page.getByText('Updated “two shells”').waitFor();
    assert.equal(await quick.locator('.home-preset').count(), 1);
    assert.match(await quick.innerText(), /Terminal ×3/);

    // Clear, then load the preset with one click.
    await page.getByRole('button', { name: 'Clear selected agents' }).click();
    await quick.getByRole('button', { name: /two shells/ }).first().click();
    assert.match(await composer.innerText(), /two shells · Terminal ×3 · 3 sessions/);
    await page.screenshot({ path: 'output/playwright/presets-loaded.png' });

    // Escape cancels naming without leaving the picker.
    await page.getByRole('button', { name: 'Fewer Terminal sessions' }).click();
    await composer.getByRole('button', { name: 'Save changes' }).click();
    await page.getByLabel('Preset name').press('Escape');
    assert.equal(await page.getByLabel('Preset name').count(), 0);

    // Launch straight from the chip.
    await quick.getByRole('button', { name: 'Launch two shells' }).click();
    await page.locator('.home').waitFor({ state: 'detached', timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('.xterm').length === 3, null, { timeout: 20000 });
    await page.screenshot({ path: 'output/playwright/presets-launched.png' });
    console.log('Presets: save, update, load, cancel and one-click launch passed.');
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
