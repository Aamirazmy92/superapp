const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// Run after npm run build: node tests/element-picker.electron.cjs
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp-picker-'));
  const projectRoot = path.join(dataDir, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(dataDir, 'workspaces.json'), JSON.stringify({
    projects: [{ id: 'picker-test', name: 'Picker test', root: projectRoot }],
    activeProject: 'picker-test',
    sessions: {},
  }));
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<body style="margin:0"><main><button id="buy" class="cta" style="margin:20px;padding:20px;font-size:20px" onclick="document.title=\'clicked\'">Buy now</button></main></body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let app;
  try {
    app = await _electron.launch({
      executablePath: require('electron'),
      args: [path.resolve('.')],
      env: { ...process.env, SUPERAPP_DATA_DIR: dataDir },
    });
    const page = await app.firstWindow();
    await page.locator('.app').waitFor();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    const browser = page.locator('.workspace-browser');
    await browser.waitFor();
    const view = page.locator('webview');
    const toggle = browser.getByRole('button', { name: 'Select an element to edit' });
    assert.equal(await toggle.isDisabled(), true, 'disabled until a page is open');

    await browser.getByRole('textbox', { name: 'Browser address' }).fill(url);
    await browser.getByRole('button', { name: 'Go', exact: true }).click();
    await page.waitForFunction((expected) => document.querySelector('webview')?.getURL() === expected, url, { timeout: 8000 });
    await page.waitForFunction(() => !document.querySelector('.workspace-browser .browser-go')?.disabled);

    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    await browser.getByText('Hover the page and click an element').waitFor();

    // Hover outlines the element under the cursor.
    const box = await view.boundingBox();
    const point = { x: box.x + 70, y: box.y + 50 };
    await page.mouse.move(point.x, point.y, { steps: 3 });
    await page.waitForFunction(() => document.querySelector('webview').executeJavaScript(
      "(() => { const o = document.querySelector('[data-superapp-picker]'); return !!o; })()"), null, { timeout: 5000 });
    const outlined = await view.evaluate((element) => element.executeJavaScript(
      "[...document.querySelectorAll('[data-superapp-picker]')].some((n) => n.style.display === 'block')"));
    assert.equal(outlined, true, 'hovered element is outlined');

    // Clicking selects it without activating the page's own handler.
    await page.mouse.click(point.x, point.y);
    const target = browser.locator('.browser-pick-target');
    await target.waitFor();
    assert.match(await target.textContent(), /^#buy$/);
    assert.equal(await view.evaluate((element) => element.executeJavaScript('document.title')), '');

    // With no agent open the request is refused and the prompt is kept.
    const input = browser.getByRole('textbox', { name: 'Describe the change' });
    await input.fill('make it blue');
    await browser.getByRole('button', { name: 'Send', exact: true }).click();
    await browser.getByRole('alert').waitFor();
    assert.match(await browser.getByRole('alert').textContent(), /Open an agent first/);
    assert.equal(await input.inputValue(), 'make it blue');

    // Picking another element and stopping both clean up the page.
    await browser.getByRole('button', { name: 'Pick a different element' }).click();
    await browser.getByText('Hover the page and click an element').waitFor();
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    const left = await view.evaluate((element) => element.executeJavaScript(
      "document.querySelectorAll('[data-superapp-picker]').length"));
    assert.equal(left, 0, 'picker removes its overlay');
    console.log('element picker ok');
  } finally {
    await app?.close();
    server.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
