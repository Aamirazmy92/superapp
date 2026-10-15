// Plugins end to end, on a copy of examples/marketplace used as the built-in
// catalog (no network): the Public storefront, one-click install with Undo,
// the install sheet, contributions in the palette, a theme, disable/enable,
// update, details and uninstall, and refused malicious plugins.
// The test unticks every "Add to Claude Code / Codex" box, so it never changes
// the real coding CLIs' configuration.
// Run with VEYO_DEV_URL unset, after `npm run build`.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(source, target);
    else await fs.copyFile(source, target);
  }
}

(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-plugins-'));
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo plugin project '));
  const market = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-market-')), 'market');
  await copyDir(path.resolve('examples/marketplace'), market);
  await fs.mkdir('output/playwright', { recursive: true });
  const env = { ...process.env, VEYO_DATA_DIR: dataDir, VEYO_PUBLIC_CATALOG: market };
  delete env.VEYO_DEV_URL;
  const app = await _electron.launch({ executablePath: require('electron'), args: [path.resolve('.'), `--project=${projectDir}`], env });
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (error) => console.log('PAGE ERROR', error.message));
    await page.locator('.home-agent-tiles .home-tile').first().waitFor();
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    const openPalette = async (text) => {
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('Control+k');
      await palette.waitFor();
      await palette.getByRole('textbox').fill(text);
    };
    const paletteRows = async (text) => {
      await openPalette(text);
      const rows = await palette.locator('.command-list button').allInnerTexts();
      await page.keyboard.press('Escape');
      await palette.waitFor({ state: 'hidden' });
      return rows.map((row) => row.replace(/\s+/g, ' ').trim());
    };
    const plugins = page.getByRole('dialog', { name: 'Plugins' });
    const openPlugins = async () => {
      await openPalette('Plugins');
      await page.keyboard.press('Enter');
      await plugins.waitFor();
    };
    const closePlugins = async () => {
      await page.keyboard.press('Escape');
      await plugins.waitFor({ state: 'hidden' });
    };
    const toast = (text) => page.locator('.toast, [role="status"]').filter({ hasText: text }).first();
    const terminalOutput = (label) =>
      page.evaluate(async (label) => {
        const found = (await window.workspace.bootstrap()).terminals.filter((t) => t.label === label).at(-1);
        return found ? (await window.workspace.attachTerminal(found.id)).output : '';
      }, label);

    // Public: the built-in catalog, fetched on first open, with sections and icons.
    await openPlugins();
    const popular = plugins.getByRole('list', { name: 'Popular' });
    await popular.waitFor();
    assert.deepEqual(await plugins.locator('.plugins-section > h3').allInnerTexts(), ['Popular', 'All plugins']);
    assert.match(await popular.locator('.plugins-icon img').first().getAttribute('src'), /^data:image\/svg\+xml;base64,/);
    const all = plugins.getByRole('list', { name: 'All plugins' });
    assert.equal(await all.getByRole('img', { name: /evil-bypass cannot be installed/ }).count(), 0, 'invalid entries are left out of the storefront');
    await page.screenshot({ path: 'output/playwright/plugins-public.png' });

    // Prompts only: one click installs it, and Undo takes it back.
    await popular.getByRole('button', { name: 'Install Hello Prompts' }).click();
    await toast('Installed Hello Prompts').waitFor();
    await page.locator('.toast, [role="status"]').getByRole('button', { name: 'Undo' }).click();
    await popular.getByRole('button', { name: 'Install Hello Prompts' }).waitFor();
    await popular.getByRole('button', { name: 'Install Hello Prompts' }).click();
    await popular.getByRole('button', { name: 'Hello Prompts options' }).waitFor();

    // Runnable plugin: the sheet lists every command and the exact MCP command.
    await popular.getByRole('button', { name: 'Install Hello Veyo' }).click();
    const commands = plugins.getByRole('region', { name: 'Commands it can run' });
    await commands.waitFor();
    assert.match(await commands.innerText(), /node \$\{pluginRoot\}\/scripts\/hello\.mjs \$\{projectRoot\}/);
    const mcp = plugins.getByRole('region', { name: 'MCP servers' });
    await mcp.locator('.plugins-mcp-cli small, .plugins-mcp-cli code').first().waitFor();
    await page.waitForFunction(() => !document.body.innerText.includes('Checking…'));
    const mcpText = await mcp.innerText();
    assert.match(mcpText, /claude mcp add --scope user hello-veyo-everything -- npx -y @modelcontextprotocol\/server-everything|Claude Code is not installed/);
    await page.screenshot({ path: 'output/playwright/plugins-sheet.png' });
    for (const box of await mcp.getByRole('checkbox').all()) if (await box.isChecked()) await box.uncheck();
    await plugins.getByRole('button', { name: 'Install', exact: true }).click();
    await toast('Installed Hello Veyo').waitFor();
    await closePlugins();

    // Contributions appear with their provenance, and a command runs in a terminal.
    assert.deepEqual(await paletteRows('hello-veyo'), [
      'Say hello from hello-veyo',
      'Git summary from hello-veyo',
      'Prompt: review-diff from hello-veyo',
      'Skill: explain-file from hello-veyo',
    ]);
    await openPalette('Say hello');
    await page.keyboard.press('Enter');
    let output = '';
    for (let i = 0; i < 60 && !/Hello from the hello-veyo plugin/.test(output); i++) {
      await page.waitForTimeout(250);
      output = await terminalOutput('Say hello');
    }
    assert.match(output, /Hello from the hello-veyo plugin/);
    assert.ok(output.includes(projectDir), 'the project folder (with spaces) reaches the script intact');

    // Theme: choosing it applies its colours; disabling the plugin falls back.
    await page.evaluate(() => document.activeElement?.blur());
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByRole('button', { name: /Dusk from hello-veyo/ }).click();
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--accent') === '#f2a65a');
    await page.keyboard.press('Escape');

    // Personal: the switch disables everything from the plugin at once.
    await openPlugins();
    await plugins.getByRole('tab', { name: /Personal/ }).click();
    await plugins.getByRole('list', { name: 'Installed plugins' }).waitFor();
    await page.screenshot({ path: 'output/playwright/plugins-personal.png' });
    await plugins.getByRole('switch', { name: 'Disable Hello Veyo' }).click();
    await plugins.getByRole('switch', { name: 'Enable Hello Veyo' }).waitFor();
    await closePlugins();
    assert.deepEqual(await paletteRows('hello-veyo'), []);
    await page.waitForFunction(() => !document.documentElement.style.getPropertyValue('--accent'));
    await openPlugins();
    await plugins.getByRole('tab', { name: /Personal/ }).click();
    await plugins.getByRole('switch', { name: 'Enable Hello Veyo' }).click();
    await plugins.getByRole('switch', { name: 'Disable Hello Veyo' }).waitFor();
    await closePlugins();
    assert.equal((await paletteRows('hello-veyo')).length, 4);

    // Update: a newer version appears after refreshing the catalog, with the change list.
    const indexFile = path.join(market, '.veyo-plugin', 'marketplace.json');
    const manifestFile = path.join(market, 'plugins', 'hello-veyo', '.veyo-plugin', 'plugin.json');
    const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    index.plugins.find((entry) => entry.name === 'hello-veyo').version = '1.1.0';
    await fs.writeFile(indexFile, JSON.stringify(index, null, 2));
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    manifest.version = '1.1.0';
    manifest.contributes.commands.push({ id: 'node-version', title: 'Node version', run: { program: 'node', args: ['--version'] } });
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    await openPlugins();
    await plugins.getByRole('button', { name: 'Refresh the catalog' }).click();
    await popular.getByRole('button', { name: 'Update Hello Veyo' }).click();
    await plugins.getByRole('list', { name: 'What changes' }).waitFor();
    const changes = await plugins.getByRole('list', { name: 'What changes' }).innerText();
    assert.match(changes, /Version 1\.0\.0 → 1\.1\.0/);
    assert.match(changes, /Adds command node-version/);
    for (const box of await plugins.getByRole('region', { name: 'MCP servers' }).getByRole('checkbox').all()) if (await box.isChecked()) await box.uncheck();
    await plugins.getByRole('button', { name: 'Update', exact: true }).click();
    await toast('Updated Hello Veyo').waitFor();
    await closePlugins();
    assert.ok((await paletteRows('Node version')).includes('Node version from hello-veyo'));

    // Search, marketplace settings and a refused malicious folder.
    await openPlugins();
    await plugins.getByLabel('Search plugins').fill('summarizes');
    assert.deepEqual(await plugins.getByRole('list', { name: 'Search results' }).locator('.plugins-card-text strong').allInnerTexts(), ['Hello Prompts']);
    await plugins.getByLabel('Search plugins').fill('');
    await plugins.getByRole('button', { name: 'Manage marketplaces' }).click();
    const markets = plugins.getByRole('list', { name: 'Marketplaces' });
    await markets.getByText('Built in').waitFor();
    assert.equal(await markets.getByRole('button', { name: 'Remove veyo-examples' }).count(), 0, 'the built-in catalog cannot be removed');
    await plugins.getByRole('button', { name: 'Back' }).click();
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, path.join(market, 'plugins', 'evil-bypass'));
    await plugins.getByRole('button', { name: 'Add' }).click();
    await plugins.getByRole('menuitem', { name: 'From folder…' }).click();
    await plugins.getByRole('alert').filter({ hasText: 'cannot change approval' }).waitFor();
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'plugins', 'staging')), []);

    // Details: README and uninstall.
    await plugins.getByRole('tab', { name: /Personal/ }).click();
    await plugins.getByRole('button', { name: 'Hello Veyo details' }).click();
    await plugins.getByRole('region', { name: 'README' }).waitFor();
    await page.screenshot({ path: 'output/playwright/plugins-details.png' });
    await plugins.getByRole('button', { name: 'Uninstall…' }).click();
    await plugins.getByRole('button', { name: 'Uninstall', exact: true }).click();
    await toast('Uninstalled Hello Veyo').waitFor();
    await closePlugins();
    assert.deepEqual(await paletteRows('hello-veyo'), []);
    console.log('plugins.electron: ok');
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
