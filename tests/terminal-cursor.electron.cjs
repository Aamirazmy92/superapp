const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// Run after npm run build: node tests/terminal-cursor.electron.cjs
// Uses a temporary app profile and synthetic terminal output; no agent prompts.
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp-cursor-'));
  await fs.writeFile(
    path.join(dataDir, 'workspaces.json'),
    JSON.stringify({
      projects: [{ id: 'cursor-test', root: dataDir, name: 'Cursor test' }],
      activeProject: 'cursor-test',
      sessions: {},
    }),
  );
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [path.resolve('.')],
    env: { ...process.env, SUPERAPP_DATA_DIR: dataDir },
  });
  try {
    const page = await app.firstWindow();
    const preselectedAgent = page.locator('.agent-picker-select[aria-pressed="true"]');
    await preselectedAgent.first().waitFor();
    await preselectedAgent.first().click();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.getByRole('button', { name: 'Launch workspace', exact: true }).click();
    await page.locator('.terminal-pane-header').click();
    const id = await page.evaluate(
      async () => (await window.workspace.bootstrap()).terminals[0].id,
    );
    let seq = 1000000;
    const output = async (data) => {
      await app.evaluate(
        ({ BrowserWindow }, event) => {
          BrowserWindow.getAllWindows()[0].webContents.send('terminal:event', event);
        },
        { id, seq: seq++, data },
      );
    };
    const cursor = page.locator('.terminal-host .xterm-cursor');
    // A CLI can request a block cursor and explicit RGB cell backgrounds.
    await output(
      '\x1b[2J\x1b[H\x1b[?25h\x1b[1 q\x1b[48;2;38;38;38m\x1b[38;2;110;110;110m> Ask anything\x1b[1;3H',
    );
    await page.waitForFunction(() => {
      const el = document.querySelector('.terminal-host .xterm-cursor');
      return el && getComputedStyle(el, '::after').width === '2px';
    });
    const caret = () =>
      page.evaluate(() => {
        const el = document.querySelector('.terminal-host .xterm-cursor');
        const style = getComputedStyle(el, '::after');
        return {
          content: style.content,
          width: style.width,
          background: style.backgroundColor,
          display: style.display,
          animation: style.animationName,
          rect: el.getBoundingClientRect().toJSON(),
        };
      });
    let state = await caret();
    assert.equal(state.width, '2px');
    assert.equal(state.background, 'rgb(217, 119, 87)');
    assert.equal(state.animation, 'terminal-caret-pulse');
    const firstX = state.rect.x;
    await output('\x1b[1;8H');
    await page.waitForFunction(
      (x) => document.querySelector('.xterm-cursor')?.getBoundingClientRect().x > x,
      firstX,
    );
    await output('\x1b[2;4H');
    await page.waitForFunction(
      (y) => document.querySelector('.xterm-cursor')?.getBoundingClientRect().y > y,
      state.rect.y,
    );
    await page.getByRole('button', { name: 'Settings', exact: false }).first().focus();
    assert.equal((await caret()).display, 'none');
    await page.locator('.xterm-helper-textarea').focus();
    assert.notEqual((await caret()).display, 'none');
    await page.evaluate(() => document.documentElement.classList.add('reduce-motion'));
    assert.equal((await caret()).animation, 'none');
    assert.notEqual((await caret()).display, 'none');
    await output('\x1b[?25l');
    await cursor.waitFor({ state: 'detached' });
    await output('\x1b[?25h');
    await cursor.waitFor();
    console.log(
      'PASS: colored CLI cells, horizontal and multiline movement, focus, reduced motion, hide/show',
    );
  } finally {
    await app.close();
    // Leave the isolated temp profile available for debugging if cleanup is locked by Windows.
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('superapp-cursor-'));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
