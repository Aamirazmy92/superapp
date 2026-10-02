const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// Run after npm run build: node tests/browser.electron.cjs
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp-browser-'));
  const projectRoot = path.join(dataDir, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'index.html'), '<h1>Project</h1>');
  await fs.writeFile(path.join(dataDir, 'workspaces.json'), JSON.stringify({
    projects: [{ id: 'browser-test', name: 'Browser test', root: projectRoot }],
    activeProject: 'browser-test',
    sessions: {},
  }));
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/third'
      ? '<h1>Third page</h1>'
      : request.url === '/next'
        ? '<h1>Second page</h1>'
        : '<h1>First page</h1><a href="/next">Next</a>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
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
    await page.locator('.workspace-sidebar').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    const browser = page.locator('.workspace-browser');
    await browser.waitFor();
    const view = page.locator('webview');
    const clearButton = browser.getByRole('button', { name: 'Clear browsing history' });
    const clearedMessage = 'Browsing history cleared. Current page and site sign-ins kept.';
    const waitUntilIdle = () => page.waitForFunction(() => {
      const button = document.querySelector('.workspace-browser button[aria-label="Clear browsing history"]');
      return button && !button.disabled;
    });
    const assertHistoryCleared = async () => {
      await browser.getByRole('status').waitFor();
      assert.equal(await browser.getByRole('status').textContent(), clearedMessage);
      assert.equal(await browser.getByRole('button', { name: 'Back', exact: true }).isDisabled(), true);
      assert.equal(await browser.getByRole('button', { name: 'Forward', exact: true }).isDisabled(), true);
      assert.equal(await view.evaluate((element) => element.canGoBack()), false);
      assert.equal(await view.evaluate((element) => element.canGoForward()), false);
    };
    const navigateTo = async (pathname) => {
      const url = `http://127.0.0.1:${port}${pathname}`;
      await browser.getByRole('textbox', { name: 'Browser address' }).fill(url);
      await browser.getByRole('button', { name: 'Go', exact: true }).click();
      await page.waitForFunction((expected) => document.querySelector('webview')?.getURL() === expected,
        url, { timeout: 8000 });
      await waitUntilIdle();
    };
    // Empty navigation history is a safe, repeatable operation.
    await waitUntilIdle();
    await clearButton.click();
    await assertHistoryCleared();
    assert.equal(await view.evaluate((element) => element.getURL()), 'about:blank');
    assert.equal(await page.locator('.workspace-sidebar').isVisible(), true);
    const resizeHandle = page.getByRole('separator', { name: 'Resize browser panel' });
    const initialBrowserWidth = await browser.evaluate((element) => element.getBoundingClientRect().width);
    const handleBox = await resizeHandle.boundingBox();
    assert.ok(handleBox);
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 80);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 37, handleBox.y + 80, { steps: 4 });
    await page.mouse.up();
    const draggedBrowserWidth = await browser.evaluate((element) => element.getBoundingClientRect().width);
    assert.ok(draggedBrowserWidth > initialBrowserWidth + 20, 'dragging the separator should widen the browser');
    await resizeHandle.focus();
    await page.keyboard.press('ArrowLeft');
    const keyboardResizedWidth = await browser.evaluate((element) => element.getBoundingClientRect().width);
    assert.ok(keyboardResizedWidth > draggedBrowserWidth, 'ArrowLeft should widen the browser');
    await browser.getByRole('textbox', { name: 'Browser address' }).fill(`http://127.0.0.1:${port}`);
    await browser.getByRole('button', { name: 'Go' }).click();
    await page.waitForFunction((expected) => document.querySelector('webview')?.getURL() === expected,
      `http://127.0.0.1:${port}/`, { timeout: 8000 });
    assert.equal(await page.locator('webview').evaluate((view) => view.executeJavaScript('document.querySelector("h1").textContent')), 'First page');
    assert.equal(await page.locator('webview').evaluate((view) => view.executeJavaScript('typeof window.workspace')), 'undefined');
    await page.locator('webview').evaluate((view) => view.executeJavaScript('localStorage.setItem("browser-test", "works")'));
    await fs.mkdir(path.join('output', 'playwright'), { recursive: true });
    await page.screenshot({ path: 'output/playwright/workspace-browser.png' });
    await browser.getByRole('textbox', { name: 'Browser address' }).fill(`http://127.0.0.1:${port}/next`);
    await browser.getByRole('button', { name: 'Go' }).click();
    await page.waitForFunction((expected) => document.querySelector('webview')?.getURL() === expected,
      `http://127.0.0.1:${port}/next`, { timeout: 8000 });
    assert.equal(await page.locator('webview').evaluate((view) => view.executeJavaScript('document.querySelector("h1").textContent')), 'Second page');
    assert.equal(await page.locator('webview').evaluate((view) => view.executeJavaScript('localStorage.getItem("browser-test")')), 'works');
    assert.equal(await browser.getByRole('status').count(), 0, 'navigation should dismiss the clear-history confirmation');
    await browser.getByRole('button', { name: 'Back' }).click();
    await page.waitForFunction((expected) => document.querySelector('webview')?.getURL() === expected,
      `http://127.0.0.1:${port}/`, { timeout: 8000 });
    await browser.getByRole('button', { name: 'Forward' }).click();
    await page.waitForFunction((expected) => document.querySelector('webview')?.getURL() === expected,
      `http://127.0.0.1:${port}/next`, { timeout: 8000 });
    const pageInfo = () => page.locator('webview').evaluate((view) => view.executeJavaScript(
      '({ width: innerWidth, dpr: devicePixelRatio, ua: navigator.userAgent, coarse: matchMedia("(pointer: coarse)").matches, h1: document.querySelector("h1")?.textContent })'));
    const waitForWidth = (width) => page.waitForFunction((expected) => document.querySelector('webview')
      ?.executeJavaScript('innerWidth').then((value) => value === expected), width, { timeout: 8000 });
    await browser.getByRole('radio', { name: 'Mobile' }).click();
    await waitForWidth(412);
    let info = await pageInfo();
    assert.match(info.ua, /Android .* Mobile Safari/);
    assert.equal(info.coarse, true);
    const mobileBox = await page.locator('.workspace-browser-frame').boundingBox();
    const contentBox = await page.locator('.workspace-browser-content').boundingBox();
    assert.ok(mobileBox.width < contentBox.width && mobileBox.height < contentBox.height, 'mobile frame should fit inside the panel');
    assert.ok(Math.abs(mobileBox.width / mobileBox.height - 412 / 915) < 0.02, 'mobile frame should keep the phone aspect ratio');
    await page.screenshot({ path: 'output/playwright/workspace-browser-mobile.png' });
    await browser.getByRole('radio', { name: 'Tablet' }).click();
    await waitForWidth(800);
    await browser.getByRole('radio', { name: 'Windows PC' }).click();
    await waitForWidth(1366);
    info = await pageInfo();
    assert.match(info.ua, /Windows NT 10\.0; Win64; x64/);
    assert.equal(info.coarse, false);
    assert.equal(info.h1, 'Second page');
    // The scaled-down frame must still map clicks to the right page point.
    await page.locator('webview').evaluate((view) => view.executeJavaScript(
      'addEventListener("click", (e) => { window.lastClick = [e.clientX, e.clientY]; }); true'));
    const desktopBox = await page.locator('.workspace-browser-frame').boundingBox();
    // Sharpness: the page must be drawn at the pixels it occupies on screen,
    // not rendered full size and shrunk afterwards.
    const hostRatio = await page.evaluate(() => devicePixelRatio);
    assert.ok(Math.abs(info.dpr - desktopBox.width * hostRatio / 1366) < 0.01, `page renders at ${info.dpr}x`);
    assert.ok(Math.abs(desktopBox.width / desktopBox.height - 1366 / 768) < 0.02, 'PC frame should keep its aspect ratio');
    await page.mouse.click(desktopBox.x + desktopBox.width * 0.75, desktopBox.y + desktopBox.height * 0.5);
    const click = await page.locator('webview').evaluate((view) => view.executeJavaScript('window.lastClick'));
    assert.ok(Math.abs(click[0] - 1366 * 0.75) < 8 && Math.abs(click[1] - 768 * 0.5) < 8, `click mapped to ${click}`);
    await page.screenshot({ path: 'output/playwright/workspace-browser-desktop.png' });
    await browser.getByRole('radio', { name: 'Fit to panel' }).click();
    await page.waitForFunction(() => document.querySelector('webview')
      ?.executeJavaScript('navigator.userAgent').then((ua) => /Electron/.test(ua)), null, { timeout: 8000 });
    const fitBox = await page.locator('.workspace-browser-frame').boundingBox();
    assert.ok(Math.abs(fitBox.width - contentBox.width) < 2, 'fit mode should fill the panel again');
    // Clear from the middle of the stack so both directions must be erased.
    await navigateTo('/third');
    await browser.getByRole('button', { name: 'Back', exact: true }).click();
    await page.waitForFunction((expected) => document.querySelector('webview')?.getURL() === expected,
      `http://127.0.0.1:${port}/next`, { timeout: 8000 });
    await waitUntilIdle();
    assert.equal(await browser.getByRole('button', { name: 'Back', exact: true }).isEnabled(), true);
    assert.equal(await browser.getByRole('button', { name: 'Forward', exact: true }).isEnabled(), true);
    await view.evaluate((element) => element.executeJavaScript(`(async () => {
      document.cookie = 'browser-test=signed-in; path=/';
      const cache = await caches.open('browser-test');
      await cache.put('/history-test-cache', new Response('keep cached data'));
      window.historyTestMarker = 'current document retained';
    })()`));
    const assertSiteDataKept = async () => {
      assert.deepEqual(await view.evaluate((element) => element.executeJavaScript(`(async () => {
        const cache = await caches.open('browser-test');
        const cached = await cache.match('/history-test-cache');
        return {
          localStorage: localStorage.getItem('browser-test'),
          signedIn: document.cookie.split('; ').includes('browser-test=signed-in'),
          cached: cached ? await cached.text() : null,
        };
      })()`)), { localStorage: 'works', signedIn: true, cached: 'keep cached data' });
    };
    const hostId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.id);
    for (const guestId of [undefined, -1, 'invalid', hostId]) {
      const error = await page.evaluate(async (id) => {
        try {
          await window.workspace.clearBrowserHistory(id);
          return null;
        } catch (failure) {
          return failure.message;
        }
      }, guestId);
      assert.match(error || '', /Browser view is no longer available/);
    }
    assert.equal(await view.evaluate((element) => element.canGoBack()), true, 'invalid requests must leave history intact');
    assert.equal(await view.evaluate((element) => element.canGoForward()), true, 'invalid requests must leave forward history intact');
    await clearButton.click();
    await assertHistoryCleared();
    assert.equal(await view.evaluate((element) => element.getURL()), `http://127.0.0.1:${port}/next`);
    assert.equal(await browser.getByRole('textbox', { name: 'Browser address' }).inputValue(), `http://127.0.0.1:${port}/next`);
    assert.equal(await view.evaluate((element) => element.executeJavaScript('document.querySelector("h1").textContent')), 'Second page');
    assert.equal(await view.evaluate((element) => element.executeJavaScript('window.historyTestMarker')), 'current document retained');
    await assertSiteDataKept();
    await page.screenshot({ path: 'output/playwright/workspace-browser-history-cleared.png' });
    await clearButton.click();
    await assertHistoryCleared();
    await assertSiteDataKept();
    // New browsing starts a new stack rooted at the retained current page.
    await navigateTo('/third');
    assert.equal(await browser.getByRole('status').count(), 0);
    assert.equal(await browser.getByRole('button', { name: 'Back', exact: true }).isEnabled(), true);
    await browser.getByRole('button', { name: 'Back', exact: true }).click();
    await page.waitForFunction((expected) => document.querySelector('webview')?.getURL() === expected,
      `http://127.0.0.1:${port}/next`, { timeout: 8000 });
    await waitUntilIdle();
    assert.equal(await view.evaluate((element) => element.canGoBack()), false, 'cleared entries must not become reachable again');
    await clearButton.click();
    await assertHistoryCleared();
    const closedGuestId = await view.evaluate((element) => element.getWebContentsId());
    await browser.getByRole('button', { name: 'Close browser' }).click();
    await browser.waitFor({ state: 'detached' });
    const staleError = await page.evaluate(async (id) => {
      try {
        await window.workspace.clearBrowserHistory(id);
        return null;
      } catch (failure) {
        return failure.message;
      }
    }, closedGuestId);
    assert.match(staleError || '', /Browser view is no longer available/);
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await browser.waitFor();
    await waitUntilIdle();
    assert.equal(await view.evaluate((element) => element.canGoBack()), false);
    assert.equal(await view.evaluate((element) => element.canGoForward()), false);
    await navigateTo('/next');
    await assertSiteDataKept();
    await clearButton.click();
    await assertHistoryCleared();
    // A host name that doesn't exist falls back to searching for it.
    await browser.getByRole('textbox', { name: 'Browser address' }).fill('superapp-test.invalid');
    await browser.getByRole('button', { name: 'Go' }).click();
    await page.waitForFunction(() => document.querySelector('.workspace-browser input')?.value
      === 'https://www.google.com/search?q=superapp-test.invalid', null, { timeout: 15000 });
    await browser.getByRole('button', { name: 'Close browser' }).click();
    await browser.waitFor({ state: 'detached' });
    console.log('Header views and embedded browser navigation passed.');
  } finally {
    await app?.close();
    await new Promise((resolve) => server.close(resolve));
    if (!path.resolve(dataDir).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
        !path.basename(dataDir).startsWith('superapp-browser-'))
      throw new Error('Refusing to remove a directory outside the test profile.');
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
