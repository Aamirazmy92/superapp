const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// Run after npm run build: node tests/terminal-drop.electron.cjs
// Drops files and web images on a shell terminal and checks the paths it types.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-drop-'));
  const pictures = path.join(dataDir, 'My Pictures');
  await fs.mkdir(pictures);
  const onDisk = path.join(pictures, 'shot 1.png');
  await fs.writeFile(onDisk, PNG);
  await fs.writeFile(
    path.join(dataDir, 'workspaces.json'),
    JSON.stringify({
      projects: [{ id: 'drop-test', root: dataDir, name: 'Drop test' }],
      activeProject: 'drop-test',
      sessions: {},
    }),
  );
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'image/png');
    response.end(PNG);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const imageURL = `http://127.0.0.1:${server.address().port}/photos/cat.png`;
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [path.resolve('.')],
    env: { ...process.env, VEYO_DATA_DIR: dataDir },
  });
  try {
    const page = await app.firstWindow();
    const preselectedAgent = page.locator('.agent-picker-select[aria-pressed="true"]');
    await preselectedAgent.first().waitFor();
    await preselectedAgent.first().click();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.getByRole('button', { name: 'Launch workspace', exact: true }).click();
    await page.locator('.terminal-pane-header').waitFor();
    // Record what the terminal sends to its process.
    await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers;
      const write = handlers.get('terminal:write');
      globalThis.__writes = [];
      handlers.set('terminal:write', (event, id, data) => {
        globalThis.__writes.push(data);
        return write(event, id, data);
      });
    });
    const typed = async () => {
      const writes = await app.evaluate(() => globalThis.__writes.splice(0));
      // Drop bracketed-paste markers and focus reports; keep what was typed.
      return writes.join('').replace(/\x1b\[20[01]~|\x1b\[[IO]/g, '');
    };
    const waitForTyped = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const text = await typed();
        if (text) return text;
        await page.waitForTimeout(100);
      }
      throw new Error('Nothing was typed into the terminal.');
    };
    // Builds the drop in the page: real files come from a file input, so they
    // carry their path on disk the way files dragged from Explorer do.
    const input = await page.evaluateHandle(() => {
      const element = document.createElement('input');
      element.type = 'file';
      element.multiple = true;
      document.body.append(element);
      return element;
    });
    const drop = (kind, payload) =>
      page.evaluate(
        ([kind, payload, input]) => {
          const transfer = new DataTransfer();
          if (kind === 'disk') for (const file of input.files) transfer.items.add(file);
          if (kind === 'bytes') {
            const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
            transfer.items.add(new File([bytes], 'from browser.png', { type: 'image/png' }));
          }
          if (kind === 'web') {
            transfer.setData('text/uri-list', 'https://example.test/article');
            transfer.setData('text/html', `<a href="/article"><img src="${payload}"></a>`);
          }
          const target = document.querySelector('.terminal-host');
          for (const type of ['dragenter', 'dragover', 'drop'])
            target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
        },
        [kind, payload, input],
      );

    await input.setInputFiles([onDisk]);
    await drop('disk');
    // A plain PowerShell terminal: single quotes, which expand nothing.
    assert.equal(await waitForTyped(), `'${onDisk}'`);

    const savedDir = path.join(dataDir, 'terminal-drops');
    await drop('bytes', PNG.toString('base64'));
    const saved = (await waitForTyped()).replace(/["']/g, '');
    assert.equal(path.dirname(saved), savedDir);
    assert.match(path.basename(saved), /^from-browser-[a-f0-9]{8}\.png$/);
    assert.deepEqual(await fs.readFile(saved), PNG);

    await page.locator('.terminal-host').dispatchEvent('dragenter', {
      dataTransfer: await page.evaluateHandle(() => {
        const transfer = new DataTransfer();
        transfer.setData('text/uri-list', 'https://example.test/');
        return transfer;
      }),
    });
    await page.locator('.terminal-drop-overlay').waitFor();
    await page.screenshot({ path: 'output/playwright/terminal-drop-overlay.png' });
    await page.locator('.terminal-host').dispatchEvent('dragleave');
    await page.locator('.terminal-drop-overlay').waitFor({ state: 'detached' });

    await drop('web', imageURL);
    const downloaded = await waitForTyped();
    assert.match(path.basename(downloaded), /^cat-[a-f0-9]{8}\.png$/);
    assert.deepEqual(await fs.readFile(downloaded), PNG);
    console.log('PASS: dropped files, browser images and web image links are typed as paths');
  } finally {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
