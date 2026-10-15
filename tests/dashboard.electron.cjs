const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// Run after npm run build: node tests/dashboard.electron.cjs
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-dashboard-'));
  const roots = [path.join(dataDir, 'alpha'), path.join(dataDir, 'beta')];
  const fakeAgent = path.join(dataDir, 'codex.cmd');
  await Promise.all(roots.map((root) => fs.mkdir(root)));
  await fs.writeFile(path.join(dataDir, 'agent.cjs'), 'setInterval(() => {}, 1000);\n');
  await fs.writeFile(
    fakeAgent,
    `@echo off\r\n"${process.execPath}" "${path.join(dataDir, 'agent.cjs')}"\r\n`,
  );
  await fs.writeFile(
    path.join(dataDir, 'workspaces.json'),
    JSON.stringify({
      projects: [
        { id: 'alpha', name: 'Alpha', root: roots[0] },
        { id: 'beta', name: 'Beta', root: roots[1] },
      ],
      activeProject: 'alpha',
      sessions: {},
    }),
  );
  // Empty sign-in folders keep plan usage off the network and away from real accounts;
  // tests/usage.electron.cjs covers it.
  const claudeDir = path.join(dataDir, 'claude-config');
  const codexHome = path.join(dataDir, 'codex-home');
  await fs.mkdir(claudeDir);
  await fs.mkdir(codexHome);
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [path.resolve('.')],
    env: {
      ...process.env,
      PATH: `${dataDir}${path.delimiter}${process.env.PATH}`,
      VEYO_DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: codexHome,
      // The terminal stub does not implement app-server authentication.
      // Empty file-backed profiles keep this dashboard-only test isolated.
      VEYO_USAGE_TEST_ORIGIN: 'http://127.0.0.1:9',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.locator('.app').waitFor();
    const created = await page.evaluate(async () => {
      const a = await window.workspace.launchAgents('alpha', [{ agentId: 'codex', count: 1 }]);
      const b = await window.workspace.launchAgents('beta', [{ agentId: 'codex', count: 1 }]);
      return { a, b };
    });
    assert.equal(created.a.created.length, 1, created.a.errors.join(' '));
    assert.equal(created.b.created.length, 1, created.b.errors.join(' '));
    await page.reload();
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    const dashboard = page.locator('#agent-dashboard');
    await dashboard.waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll('.agent-dashboard-agent').length === 2,
    );
    assert.equal(await dashboard.locator('.agent-dashboard-total strong').textContent(), '2');
    assert.equal(await dashboard.locator('.status-idle .agent-dashboard-agent').count(), 2);

    await dashboard.getByRole('tab', { name: 'Usage' }).click();
    await dashboard
      .getByText('Sign in to Codex with ChatGPT to see plan usage.', { exact: true })
      .waitFor();
    assert.equal(
      await dashboard.locator('.usage-panel').count(),
      1,
      'usage remains discoverable without a signed-in CLI',
    );
    assert.equal(await dashboard.locator('.usage-card.status-signed-out').count(), 2);
    assert.match(
      await dashboard.locator('.usage-panel').textContent(),
      /Sign in to Codex with ChatGPT/,
    );
    await dashboard.getByRole('tab', { name: 'Overview' }).click();

    await dashboard.getByRole('button', { name: 'Current project' }).click();
    assert.equal(await dashboard.locator('.agent-dashboard-agent').count(), 1);
    await dashboard.getByRole('button', { name: 'All projects' }).click();
    await dashboard.locator('.agent-dashboard-agent', { hasText: 'Beta' }).click();
    await page.waitForFunction(() =>
      document.querySelector('.project-list .active')?.textContent?.includes('Beta'),
    );
    assert.equal(await dashboard.locator('.agent-dashboard-agent').count(), 2);

    await page.locator('.xterm-helper-textarea').first().focus();
    await page.keyboard.type('check status');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
      document.querySelector('.status-working .agent-dashboard-agent'),
    );
    const working = dashboard.locator('.agent-dashboard-filters button', { hasText: 'Active' });
    await working.click();
    assert.equal(await dashboard.locator('.agent-dashboard-agent').count(), 1);

    const output = async (seq, data) =>
      app.evaluate(
        ({ BrowserWindow }, event) => {
          BrowserWindow.getAllWindows()[0].webContents.send('terminal:event', event);
        },
        { id: created.b.created[0].id, seq, data, at: Date.now() },
      );
    await output(1000000, 'reply output\r\n');

    await page.waitForFunction(
      () => {
        const buttons = [...document.querySelectorAll('.agent-dashboard-filters button')];
        return buttons
          .find((button) => button.textContent?.includes('Complete'))
          ?.textContent?.includes('1');
      },
      null,
      { timeout: 25000 },
    );
    const done = dashboard.locator('.agent-dashboard-filters button', { hasText: 'Complete' });
    await done.click();
    assert.equal(await dashboard.locator('.agent-dashboard-agent').count(), 1);

    // A finished agent repainting (resize, focus) stays done.
    await output(1000001, 'redraw\r\n');
    await page.waitForTimeout(500);
    assert.equal(await dashboard.locator('.status-done .agent-dashboard-agent').count(), 1);

    // Answering it (a permission prompt, say) and output that outlasts the
    // keystroke echo moves it back to working.
    await page.locator('.xterm-helper-textarea').first().focus();
    await page.keyboard.type('1');
    await page.waitForTimeout(1600);
    await output(1000002, 'resumed reply output\r\n');
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll('.agent-dashboard-filters button')];
      return buttons
        .find((button) => button.textContent?.includes('Active'))
        ?.textContent?.includes('1');
    });
    await working.click();
    assert.equal(await dashboard.locator('.agent-dashboard-agent').count(), 1);

    await dashboard.locator('.agent-dashboard-filters button', { hasText: 'Idle' }).click();
    assert.equal(await dashboard.locator('.agent-dashboard-agent').count(), 1);
    await dashboard.locator('.agent-dashboard-filters button', { hasText: 'All' }).click();
    assert.equal(await dashboard.locator('.agent-dashboard-agent').count(), 2);
    await page.keyboard.press('Control+k');
    await page.getByRole('button', { name: 'Launch multiple agents', exact: true }).click();
    await page.getByRole('dialog', { name: 'Open terminals' }).waitFor();
    await page.getByRole('button', { name: 'Close agent launcher' }).click();

    await dashboard.getByRole('button', { name: 'Close dashboard' }).click();
    await dashboard.waitFor({ state: 'detached' });
    console.log('Dashboard counts, scope, navigation, filters, and turn transitions passed.');
  } finally {
    await app.close();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('veyo-dashboard-'));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
