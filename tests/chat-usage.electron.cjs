const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// Run after npm run build: node tests/chat-usage.electron.cjs
// The usage ring in the chat composer shows the same live plan reading as the
// dashboard. A local server stands in for the usage endpoint.
async function launch(sessionPercent) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-chat-usage-'));
  const claudeDir = path.join(dataDir, 'claude-config');
  await fs.mkdir(claudeDir);
  await fs.writeFile(
    path.join(claudeDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'claude-test-token',
        expiresAt: Date.now() + 3_600_000,
        subscriptionType: 'max',
      },
    }),
  );
  const inHours = (hours) => Date.now() + hours * 3_600_000;
  const session = sessionPercent;
  const server = http.createServer((request, response) => {
    if (request.url === '/api/oauth/usage') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          five_hour: { utilization: session, resets_at: new Date(inHours(3.3)).toISOString() },
          seven_day: { utilization: 11, resets_at: new Date(inHours(60)).toISOString() },
        }),
      );
      return;
    }
    response.writeHead(401);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const projectRoot = path.join(dataDir, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(
    path.join(dataDir, 'workspaces.json'),
    JSON.stringify({
      projects: [{ id: 'usage-fixture', name: 'Usage fixture', root: projectRoot }],
      activeProject: 'usage-fixture',
      sessions: {},
    }),
  );
  const thread = {
    id: 'usage-thread',
    title: 'New chat',
    provider: 'claude',
    model: 'default',
    permission: 'ask',
    projectId: 'usage-fixture',
    messages: [],
    draft: '',
    updatedAt: Date.now(),
  };
  await fs.writeFile(
    path.join(dataDir, 'chats.json'),
    JSON.stringify({
      threads: [thread],
      active: thread.id,
      settings: { provider: 'claude', model: 'default' },
    }),
  );
  const env = {
    ...process.env,
    VEYO_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: claudeDir,
    VEYO_USAGE_TEST_ORIGIN: `http://127.0.0.1:${server.address().port}`,
  };
  // `claude` stays off PATH so no chat process can start.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  env[pathKey] = [path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VEYO_DEV_URL;

  const app = await _electron.launch({ executablePath: require('electron'), args: [path.resolve('.')], env });
  const page = await app.firstWindow();
  await page.locator('.app').waitFor();
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  return { app, page, close: async () => { await app.close(); server.close(); } };
}

(async () => {
  const artifacts = path.resolve('output/playwright');
  await fs.mkdir(artifacts, { recursive: true });
  const { page, close } = await launch(6);
  try {

    const ring = page.getByRole('button', { name: /^Claude plan usage/ });
    await ring.waitFor();
    // The ring waits for a live reading instead of guessing one.
    await page.getByRole('button', { name: 'Claude plan usage, 11% used' }).waitFor();

    await ring.click();
    const popover = page.getByRole('dialog', { name: 'Claude usage' });
    await popover.waitFor();
    await popover.getByText('Usage', { exact: true }).waitFor();
    const session$ = popover.locator('.chat-usage-row', { hasText: 'Session limit' });
    const weekly = popover.locator('.chat-usage-row', { hasText: 'Weekly' });
    assert.match(await session$.innerText(), /6% used/);
    assert.match(await session$.innerText(), /Resets in 3h/);
    assert.match(await weekly.innerText(), /11% used/);
    assert.equal(await session$.getByRole('meter').getAttribute('aria-valuenow'), '6');
    assert.equal(await popover.locator('.chat-usage-note.warn').count(), 0);
    await page.screenshot({ path: path.join(artifacts, 'chat-usage.png') });

    // Escape closes it and returns focus to the ring.
    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'detached' });
    assert.equal(await ring.evaluate((node) => node === document.activeElement), true);

    // The provider's cooldown after a check is shown rather than hidden.
    await ring.click();
    const refresh = popover.getByRole('button', { name: 'Refresh usage' });
    assert.equal(await refresh.isDisabled(), true);
    assert.match(await refresh.getAttribute('title'), /^Refresh available in /);
  } finally {
    await close();
  }

  // Near the limit the ring turns critical and follows the fullest window.
  const near = await launch(93);
  try {
    const ring = near.page.getByRole('button', { name: 'Claude plan usage, 93% used' });
    await ring.waitFor();
    assert.equal(await ring.evaluate((node) => node.classList.contains('tone-critical')), true);
    // Drawn in the danger colour, with most of the circle filled.
    const drawn = await ring.evaluate((node) => {
      const fill = node.querySelector('.chat-usage-ring-fill');
      const dash = fill.getAttribute('stroke-dasharray').split(' ').map(Number);
      return { stroke: getComputedStyle(fill).stroke, share: dash[0] / dash[1] };
    });
    const [red, green] = drawn.stroke.match(/\d+/g).map(Number);
    assert.ok(red - green > 70, `ring is not red: ${drawn.stroke}`);
    assert.ok(Math.abs(drawn.share - 0.93) < 0.005);
    await ring.click();
    await near.page.getByRole('dialog', { name: 'Claude usage' }).waitFor();
    await near.page.screenshot({ path: path.join(artifacts, 'chat-usage-critical.png') });
  } finally {
    await near.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
