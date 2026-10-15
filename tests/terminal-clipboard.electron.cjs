const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// Run after npm run build: node tests/terminal-clipboard.electron.cjs
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-clipboard-'));
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [path.resolve('.')],
    env: { ...process.env, VEYO_DATA_DIR: dataDir },
  });
  try {
    const page = await app.firstWindow();
    await page.locator('.app').waitFor();
    const actual = await page.evaluate(() => window.workspace.readTerminalClipboard());
    const expected = await app.evaluate(async ({ clipboard }) => {
      const [text, items] = await Promise.all([clipboard.readText(), clipboard.read()]);
      return {
        text,
        hasImage: items.some((item) => item.types.some((type) => type.startsWith('image/'))),
      };
    });
    assert.deepEqual(actual, expected);
    console.log('PASS: terminal clipboard read returns text and image status over IPC');
  } finally {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
