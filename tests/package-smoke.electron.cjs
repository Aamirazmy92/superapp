const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function connect(port, child) {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Packaged app exited (${child.exitCode}). ${child.output || ''}`);
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Packaged app did not open its debugging endpoint. ${lastError?.message || ''} ${child.output || ''}`);
}

// Run after npm run package: node tests/package-smoke.electron.cjs
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp-package-smoke-'));
  const root = path.join(dataDir, 'project');
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(dataDir, 'workspaces.json'),
    JSON.stringify({
      projects: [{ id: 'package-smoke', name: 'Package smoke', root }],
      activeProject: 'package-smoke',
      sessions: {},
    }),
  );
  const executable = path.resolve(process.argv[2] || 'release/win-unpacked/Superapp.exe');
  const port = await freePort();
  const previewServer = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<h1>Packaged browser</h1>');
  });
  await new Promise((resolve) => previewServer.listen(0, '127.0.0.1', resolve));
  const previewPort = previewServer.address().port;
  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      SUPERAPP_DATA_DIR: dataDir,
      // A release must never turn an environment-supplied URL into its
      // privileged main frame, even when another process sets this variable.
      SUPERAPP_DEV_URL: 'https://example.com/',
    },
    windowsHide: true,
  });
  child.output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (data) => { child.output = (child.output + data).slice(-4000); });
  let browser;
  try {
    browser = await connect(port, child);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.waitForEvent('page'));
    await page.locator('.app').waitFor();
    assert.match(page.url(), /^file:\/\//);
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.locator('.workspace-sidebar').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await page.getByRole('textbox', { name: 'Browser address' }).fill(`http://127.0.0.1:${previewPort}`);
    await page.getByRole('button', { name: 'Go' }).click();
    await page.waitForFunction((expected) => document.querySelector('webview')?.getURL() === expected,
      `http://127.0.0.1:${previewPort}/`);
    assert.equal(await page.locator('webview').evaluate((view) => view.executeJavaScript('document.querySelector("h1").textContent')), 'Packaged browser');
    await page.getByRole('button', { name: 'Close browser' }).click();
    const terminal = await page.evaluate(() => window.workspace.createTerminal('package-smoke'));
    await page.evaluate(
      (id) => window.workspace.writeTerminal(id, 'echo PACKAGE_SMOKE\r'),
      terminal.id,
    );
    await page.waitForFunction(
      async (id) => (await window.workspace.attachTerminal(id)).output.includes('PACKAGE_SMOKE'),
      terminal.id,
    );
    await page.evaluate((id) => window.workspace.closeTerminal(id), terminal.id);
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    const choose = async (label, option) => {
      await page.getByRole('combobox', { name: label }).click();
      await page.getByRole('listbox', { name: label }).getByRole('option', { name: option }).click();
    };
    const waitForModel = async (name) => {
      await page.getByRole('combobox', { name: 'Chat model' }).click();
      await page.getByRole('listbox', { name: 'Chat model' }).getByRole('option', { name }).first().waitFor();
      await page.keyboard.press('Escape');
    };
    await choose('Chat project', /^Package smoke/);
    await choose('Chat provider', /^Codex/);
    await waitForModel(/GPT/);
    assert.equal(await page.getByRole('combobox', { name: 'Chat permissions' }).count(), 1);
    await choose('Chat permissions', /^Approve safe actions/);
    assert.match(
      await page.getByRole('combobox', { name: 'Chat permissions' }).textContent(),
      /Approve safe actions/,
    );
    await choose('Chat permissions', /^Ask for approval/);
    assert.equal(await page.getByRole('button', { name: 'Start voice chat' }).count(), 1);
    await choose('Chat provider', /^Claude/);
    assert.equal(await page.getByRole('combobox', { name: 'Chat model' }).count(), 1);
    assert.equal(await page.locator('.app').count(), 1);
    console.log('Packaged app opened, Files and browser worked, terminal ran, and agent chat controls loaded.');
  } catch (error) {
    console.error(child.output || 'No packaged-app output was captured.');
    throw error;
  } finally {
    await browser?.close();
    await new Promise((resolve) => previewServer.close(resolve));
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    if (
      !path.resolve(dataDir).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
      !path.basename(dataDir).startsWith('superapp-package-smoke-')
    )
      throw new Error('Refusing to remove a directory outside the test profile.');
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
