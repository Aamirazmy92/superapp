const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// Run after npm run build: node tests/browser.electron.cjs
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-browser-'));
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
    if (request.url === '/echo') {
      response.end(`<pre id="echo">${JSON.stringify({ ua: request.headers['user-agent'], lang: request.headers['accept-language'] })}</pre>`);
      return;
    }
    response.end(request.url === '/find'
      ? '<title>Find</title><p>apple banana apple</p><p>cherry apple</p>'
      : request.url === '/popup'
      ? '<title>Popup opener</title><a id="pop" href="/third" target="_blank">Open</a>'
      : request.url === '/third'
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
      env: { ...process.env, VEYO_DATA_DIR: dataDir },
    });
    const page = await app.firstWindow();
    await page.locator('.app').waitFor();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.locator('.workspace-sidebar').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    const browser = page.locator('.workspace-browser');
    await browser.waitFor();
    const view = page.locator('webview');
    const historyButton = browser.getByRole('button', { name: 'History', exact: true });
    const history = browser.getByRole('region', { name: 'History' });
    const clearedMessage = 'Cleared browsing history. Site sign-ins kept.';
    // Ready (Go enabled) and not loading (Reload shown instead of Stop).
    const waitUntilIdle = () => page.waitForFunction(() => {
      const go = document.querySelector('.workspace-browser .browser-tab-page:not([hidden]) .browser-go');
      return go && !go.disabled && document.querySelector('.workspace-browser button[aria-label="Reload page"]');
    });
    // Clear browsing data with only "Browsing history" ticked, as the
    // history panel offers by default.
    const clearHistory = async (range = 'all') => {
      if (!(await history.isVisible())) await historyButton.click();
      await history.getByRole('button', { name: 'Clear browsing data…' }).click();
      const form = history.getByRole('form', { name: 'Clear browsing data' });
      await form.getByRole('combobox').selectOption(range);
      assert.equal(await form.getByRole('checkbox', { name: /^Browsing history/ }).isChecked(), true);
      assert.equal(await form.getByRole('checkbox', { name: /^Cookies and other site data/ }).isChecked(), false);
      assert.equal(await form.getByRole('checkbox', { name: /^Cached images and files/ }).isChecked(), false);
      await form.getByRole('button', { name: 'Clear data' }).click();
      await history.getByRole('status').waitFor();
      assert.equal(await history.getByRole('status').textContent(), clearedMessage);
      await history.getByRole('button', { name: 'Close history' }).click();
      await history.waitFor({ state: 'detached' });
    };
    const assertHistoryCleared = async () => {
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
    await clearHistory();
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
    assert.equal(await browser.getByRole('status').count(), 0, 'closing the history dismisses its confirmation');
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
    // Fit mode is the computer's own browser: Chrome, in the system languages.
    await page.waitForFunction(() => document.querySelector('webview')
      ?.executeJavaScript('navigator.userAgent').then((ua) => /Windows NT/.test(ua) && !/Android/.test(ua)), null, { timeout: 8000 });
    await navigateTo('/echo');
    const echoed = JSON.parse(await view.evaluate((element) => element.executeJavaScript('document.getElementById("echo").textContent')));
    const systemLanguages = await app.evaluate(({ app: electronApp }) => electronApp.getPreferredSystemLanguages());
    const { acceptLanguages } = require('../electron/browser-locale.cjs');
    assert.match(echoed.ua, /^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
    assert.doesNotMatch(echoed.ua, /Electron|veyo/i);
    // Chromium weights the list: "en-GB,en-US;q=0.9,en;q=0.8".
    assert.equal(echoed.lang, acceptLanguages(systemLanguages).split(',')
      .map((tag, index) => (index ? `${tag};q=${Math.max(1, 10 - index) / 10}` : tag)).join(','));
    assert.equal(await view.evaluate((element) => element.executeJavaScript('navigator.userAgent')), echoed.ua);
    await browser.getByRole('textbox', { name: 'Browser address' }).fill(`http://127.0.0.1:${port}/next`);
    await browser.getByRole('button', { name: 'Go' }).click();
    await page.waitForFunction((expected) => document.querySelector('webview')?.getURL() === expected,
      `http://127.0.0.1:${port}/next`, { timeout: 8000 });
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
    for (const options of [undefined, 'all', {}, { range: 'forever', history: true }, { range: 'all' }, { range: 'all', history: 'yes' }]) {
      const error = await page.evaluate(async (value) => {
        try {
          await window.workspace.clearBrowsingData(value);
          return null;
        } catch (failure) {
          return failure.message;
        }
      }, options);
      assert.match(error || '', /Choose a time range to clear|Choose what to clear/);
    }
    assert.equal(await view.evaluate((element) => element.canGoBack()), true, 'invalid requests must leave history intact');
    assert.equal(await view.evaluate((element) => element.canGoForward()), true, 'invalid requests must leave forward history intact');
    await clearHistory();
    await assertHistoryCleared();
    assert.equal(await view.evaluate((element) => element.getURL()), `http://127.0.0.1:${port}/next`);
    assert.equal(await browser.getByRole('textbox', { name: 'Browser address' }).inputValue(), `http://127.0.0.1:${port}/next`);
    assert.equal(await view.evaluate((element) => element.executeJavaScript('document.querySelector("h1").textContent')), 'Second page');
    assert.equal(await view.evaluate((element) => element.executeJavaScript('window.historyTestMarker')), 'current document retained');
    await assertSiteDataKept();
    await historyButton.click();
    await page.screenshot({ path: 'output/playwright/workspace-browser-history-cleared.png' });
    await clearHistory();
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
    await clearHistory();
    await assertHistoryCleared();
    await browser.getByRole('button', { name: 'Close browser' }).click();
    await browser.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await browser.waitFor();
    await waitUntilIdle();
    // Closing only hides the browser, so its page is still open.
    assert.equal(await view.evaluate((element) => element.getURL()), `http://127.0.0.1:${port}/next`);
    assert.equal(await view.evaluate((element) => element.canGoBack()), false);
    assert.equal(await view.evaluate((element) => element.canGoForward()), false);
    await navigateTo('/next');
    await assertSiteDataKept();
    await clearHistory();
    await assertHistoryCleared();
    // The history lists visited pages, newest first, under their titles.
    await navigateTo('/find');
    await navigateTo('/popup');
    const entryTitles = () => history.locator('.browser-history-title').allTextContents();
    const waitForEntries = (expected) => page.waitForFunction((titles) => JSON.stringify(
      [...document.querySelectorAll('.browser-history-title')].map((element) => element.textContent)) === JSON.stringify(titles),
    expected, { timeout: 8000 });
    await historyButton.click();
    await waitForEntries(['Popup opener', 'Find']);
    assert.equal(await history.getByRole('heading', { name: 'Today' }).count(), 1);
    await page.screenshot({ path: 'output/playwright/workspace-browser-history.png' });
    assert.equal(await browser.locator('.browser-tabbar').isVisible(), false, 'the history takes the place of the tabs');
    await history.getByRole('searchbox', { name: 'Search history' }).fill('FIND');
    await waitForEntries(['Find']);
    await history.getByRole('searchbox', { name: 'Search history' }).fill('no such page');
    await history.getByText('No pages in your history match this search.').waitFor();
    await history.getByRole('searchbox', { name: 'Search history' }).fill('');
    await waitForEntries(['Popup opener', 'Find']);
    // Removing one page saves at once.
    await history.getByRole('button', { name: 'Remove Find from history' }).click();
    await waitForEntries(['Popup opener']);
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'browser-history.json'), 'utf8'));
    assert.deepEqual(saved.map((entry) => entry.url), [`http://127.0.0.1:${port}/popup`]);
    // Escape closes the history; Ctrl+H opens it from the browser's controls.
    await history.getByRole('searchbox', { name: 'Search history' }).press('Escape');
    await history.waitFor({ state: 'detached' });
    await navigateTo('/next');
    await browser.getByRole('textbox', { name: 'Browser address' }).press('Control+h');
    await history.waitFor();
    // Choosing a page opens it in the current tab.
    await history.getByRole('button', { name: /^Popup opener/ }).click();
    await history.waitFor({ state: 'detached' });
    await page.waitForFunction((expected) => document.querySelector('webview')?.getURL() === expected,
      `http://127.0.0.1:${port}/popup`, { timeout: 8000 });
    await waitUntilIdle();
    // Clearing the last hour leaves nothing older behind here, and clearing
    // cookies and site data signs the browser out.
    await historyButton.click();
    await history.getByRole('button', { name: 'Clear browsing data…' }).click();
    const clearForm = history.getByRole('form', { name: 'Clear browsing data' });
    await clearForm.getByRole('checkbox', { name: /^Cookies and other site data/ }).check();
    await clearForm.getByRole('checkbox', { name: /^Cached images and files/ }).check();
    await clearForm.getByText('Cookies, site data and cached files are cleared for all time.').waitFor();
    await page.screenshot({ path: 'output/playwright/workspace-browser-clear-data.png' });
    await clearForm.getByRole('button', { name: 'Clear data' }).click();
    await history.getByRole('status').waitFor();
    assert.equal(await history.getByRole('status').textContent(),
      'Cleared browsing history, cookies and other site data and cached images and files. You may need to sign in to sites again.');
    await history.getByText('Pages you visit appear here.').waitFor();
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'browser-history.json'), 'utf8')), []);
    await history.getByRole('button', { name: 'Close history' }).click();
    await assertHistoryCleared();
    // A fresh document reads storage from disk rather than its own copy.
    await browser.getByRole('button', { name: 'Reload page' }).click();
    await waitUntilIdle();
    assert.deepEqual(await view.evaluate((element) => element.executeJavaScript(`(async () => ({
      localStorage: localStorage.getItem('browser-test'),
      signedIn: document.cookie.split('; ').includes('browser-test=signed-in'),
      cached: await caches.has('browser-test'),
    }))()`)), { localStorage: null, signedIn: false, cached: false });
    // A host name that doesn't exist falls back to searching for it.
    await browser.getByRole('textbox', { name: 'Browser address' }).fill('veyo-test.invalid');
    await browser.getByRole('button', { name: 'Go' }).click();
    // ...the way Chrome searches, leaving the region to Google.
    await page.waitForFunction((expected) => document.querySelector('.workspace-browser input')?.value === expected,
      'https://www.google.com/search?q=veyo-test.invalid&sourceid=chrome&ie=UTF-8', { timeout: 15000 });
    // Tabs: each has its own page and history; inactive tabs stay loaded.
    const tabs = browser.getByRole('tab');
    const views = page.locator('webview');
    const waitForViewURL = (index, expected) => page.waitForFunction(([i, url]) =>
      document.querySelectorAll('webview')[i]?.getURL() === url, [index, expected], { timeout: 8000 });
    await browser.getByRole('textbox', { name: 'Browser address' }).fill(`http://127.0.0.1:${port}/next`);
    await browser.getByRole('button', { name: 'Go' }).click();
    await waitForViewURL(0, `http://127.0.0.1:${port}/next`);
    await browser.getByRole('button', { name: 'New tab' }).click();
    assert.equal(await tabs.count(), 2);
    assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
    const newAddress = browser.getByRole('textbox', { name: 'Browser address' });
    assert.equal(await newAddress.inputValue(), '');
    assert.equal(await newAddress.evaluate((input) => input === document.activeElement), true, 'a new tab focuses its address bar');
    await newAddress.fill(`http://127.0.0.1:${port}/third`);
    await browser.getByRole('button', { name: 'Go' }).click();
    await waitForViewURL(1, `http://127.0.0.1:${port}/third`);
    // The frame is shown once the tab has handled the navigation.
    await views.nth(1).waitFor({ state: 'visible' });
    assert.equal(await views.nth(0).isVisible(), false);
    await tabs.nth(0).click();
    assert.equal(await views.nth(0).isVisible(), true);
    assert.equal(await browser.getByRole('textbox', { name: 'Browser address' }).inputValue(), `http://127.0.0.1:${port}/next`);
    assert.equal(await views.nth(1).evaluate((view) => view.executeJavaScript('document.querySelector("h1").textContent')), 'Third page');
    await page.screenshot({ path: 'output/playwright/workspace-browser-tabs.png' });
    // Links that open a new window become a tab next to the opener.
    await browser.getByRole('textbox', { name: 'Browser address' }).fill(`http://127.0.0.1:${port}/popup`);
    await browser.getByRole('button', { name: 'Go' }).click();
    await waitForViewURL(0, `http://127.0.0.1:${port}/popup`);
    await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === 'Popup opener', null, { timeout: 8000 });
    await views.nth(0).evaluate((view) => view.executeJavaScript('document.getElementById("pop").click()', true));
    await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 3, null, { timeout: 8000 });
    assert.equal(await tabs.nth(1).getAttribute('aria-selected'), 'true');
    await waitForViewURL(1, `http://127.0.0.1:${port}/third`);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'no separate window should open');
    // Find in page, opened from the address bar.
    await browser.getByRole('textbox', { name: 'Browser address' }).fill(`http://127.0.0.1:${port}/find`);
    await browser.getByRole('button', { name: 'Go' }).click();
    await waitForViewURL(1, `http://127.0.0.1:${port}/find`);
    await browser.getByRole('textbox', { name: 'Browser address' }).press('Control+f');
    const findBox = browser.getByRole('textbox', { name: 'Find in page' });
    await findBox.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Find in page');
    await findBox.fill('apple');
    const count = browser.locator('.browser-find-count');
    const waitForCount = (expected) => page.waitForFunction((text) =>
      document.querySelector('.browser-find-count')?.textContent === text, expected, { timeout: 8000 });
    await waitForCount('1/3');
    await findBox.press('Enter');
    await waitForCount('2/3');
    await findBox.press('Shift+Enter');
    await waitForCount('1/3');
    await page.screenshot({ path: 'output/playwright/workspace-browser-find.png' });
    await findBox.fill('durian');
    await waitForCount('0/0');
    assert.equal(await browser.getByRole('button', { name: 'Next match' }).isDisabled(), true);
    await findBox.press('Escape');
    await findBox.waitFor({ state: 'detached' });
    assert.equal(await count.count(), 0);
    // Chrome's shortcuts also work while the page itself has focus. Keys go
    // through Electron's input path: Playwright's keyboard skips the
    // before-input-event the browser listens to.
    const pageBox = await views.nth(1).boundingBox();
    const pressInPage = async (keyCode) => {
      await page.mouse.click(pageBox.x + 40, pageBox.y + 40);
      await page.waitForFunction(() => document.activeElement?.tagName === 'WEBVIEW');
      const id = await views.nth(1).evaluate((element) => element.getWebContentsId());
      await app.evaluate(({ webContents }, [guest, code]) => {
        for (const type of ['keyDown', 'keyUp'])
          webContents.fromId(guest).sendInputEvent({ type, keyCode: code, modifiers: ['control'] });
      }, [id, keyCode]);
    };
    await views.nth(1).evaluate((element) => element.executeJavaScript(
      'window.pageKeys = []; addEventListener("keydown", (e) => pageKeys.push(e.key)); true'));
    await pressInPage('F');
    await findBox.waitFor();
    assert.deepEqual(await views.nth(1).evaluate((element) => element.executeJavaScript('pageKeys')), [],
      'the page should not also receive the shortcut');
    await findBox.press('Escape');
    await pressInPage('L');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Browser address');
    await pressInPage('T');
    await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 4, null, { timeout: 8000 });
    assert.equal(await tabs.nth(2).getAttribute('aria-selected'), 'true');
    await browser.getByRole('textbox', { name: 'Browser address' }).press('Control+w');
    await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 3);
    await tabs.nth(1).click();
    // The right-click menu: links open in a new tab, selections search.
    const guestId = await views.nth(1).evaluate((element) => element.getWebContentsId());
    const menuLabels = await app.evaluate(({ Menu, webContents }, id) => {
      const shown = [];
      const original = Menu.buildFromTemplate;
      Menu.buildFromTemplate = (template) => { shown.push(template); return { popup() {} }; };
      try {
        const guest = webContents.fromId(id);
        const base = { x: 1, y: 1, editFlags: {}, mediaType: 'none' };
        guest.emit('context-menu', {}, { ...base, linkURL: 'javascript:alert(1)' });
        guest.emit('context-menu', {}, { ...base, selectionText: 'apple' });
        shown[1].find((item) => item.label?.startsWith('Search Google')).click();
        return shown.map((template) => template.map((item) => item.label ?? '-'));
      } finally {
        Menu.buildFromTemplate = original;
      }
    }, guestId);
    assert.deepEqual(menuLabels[0], ['Back', 'Forward', 'Reload', '-', 'Print…', '-', 'Inspect']);
    assert.deepEqual(menuLabels[1], ['Copy', '-', 'Search Google for “apple”', '-', 'Inspect']);
    await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 4, null, { timeout: 8000 });
    // Google may first redirect to its cookie consent page, keeping the search.
    await page.waitForFunction((expected) => decodeURIComponent(document.querySelectorAll('webview')[2]?.getURL() ?? '').includes(expected),
      'https://www.google.com/search?q=apple&sourceid=chrome&ie=UTF-8', { timeout: 15000 });
    await browser.getByRole('textbox', { name: 'Browser address' }).press('Control+w');
    await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 3);
    await tabs.nth(1).click();
    await browser.getByRole('textbox', { name: 'Browser address' }).press('Control+w');
    assert.equal(await tabs.count(), 2);
    await browser.getByRole('button', { name: /^Close tab / }).nth(1).click();
    assert.equal(await tabs.count(), 1);
    await browser.getByRole('button', { name: /^Close tab / }).click();
    await browser.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await browser.waitFor();
    await browser.getByRole('button', { name: 'Close browser' }).click();
    await browser.waitFor({ state: 'hidden' });
    console.log('Header views and embedded browser navigation passed.');
  } finally {
    await app?.close();
    await new Promise((resolve) => server.close(resolve));
    if (!path.resolve(dataDir).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
        !path.basename(dataDir).startsWith('veyo-browser-'))
      throw new Error('Refusing to remove a directory outside the test profile.');
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
