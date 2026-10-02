const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

// Run after npm run build: node tests/usage.electron.cjs
// A local server stands in for both usage endpoints, so nothing leaves the machine.
(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superapp-usage-'));
  const claudeDir = path.join(dataDir, 'claude-config');
  const codexHome = path.join(dataDir, 'codex-home');
  const sessionDay = path.join(codexHome, 'sessions', '2026', '09', '30');
  await fs.mkdir(claudeDir);
  await fs.mkdir(sessionDay, { recursive: true });
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
  await fs.writeFile(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'codex-test-token',
        account_id: 'test-account',
        id_token: `header.${Buffer.from(JSON.stringify({ sub: 'test-user' })).toString('base64url')}.signature`,
      },
    }),
  );
  const inHours = (hours) => Date.now() + hours * 3_600_000;
  await fs.writeFile(
    path.join(sessionDay, 'rollout-test.jsonl'),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          account_id: 'test-account',
          user_id: 'test-user',
          plan_type: 'plus',
          primary: {
            used_percent: 42,
            window_minutes: 300,
            resets_at: Math.floor(inHours(2) / 1000),
          },
          secondary: {
            used_percent: 93,
            window_minutes: 10080,
            resets_at: Math.floor(inHours(50) / 1000),
          },
        },
      },
    }) + '\n',
  );

  const requests = [];
  let claudeStatus = 200;
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.url === '/api/oauth/usage' && claudeStatus === 200) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          five_hour: { utilization: 92, resets_at: new Date(inHours(2)).toISOString() },
          seven_day: { utilization: 30, resets_at: new Date(inHours(50)).toISOString() },
          seven_day_opus: { utilization: 50, resets_at: new Date(inHours(50)).toISOString() },
        }),
      );
      return;
    }
    // Claude when switched off, and Codex always: a rejected sign-in.
    response.writeHead(request.url === '/api/oauth/usage' ? claudeStatus : 401);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    ...process.env,
    SUPERAPP_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexHome,
    SUPERAPP_USAGE_TEST_ORIGIN: `http://127.0.0.1:${server.address().port}`,
  };
  delete env.SUPERAPP_DEV_URL;
  const launch = () =>
    _electron.launch({ executablePath: require('electron'), args: [path.resolve('.')], env });

  let app = await launch();
  const artifacts = path.resolve('output/playwright');
  await fs.mkdir(artifacts, { recursive: true });
  try {
    let page = await app.firstWindow();
    await page.locator('.app').waitFor();

    // Usage appears only in the dashboard; the app header has no usage summary.
    assert.equal(await page.locator('.titlebar .usage-indicator').count(), 0);
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    const dashboard = page.locator('#agent-dashboard');
    await dashboard.waitFor();
    await dashboard.getByRole('tab', { name: 'Usage' }).click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('.usage-card[data-provider="claude"] [role="meter"]')
          ?.getAttribute('aria-valuenow') === '92',
    );
    assert.equal(
      requests.find((request) => request.url === '/api/oauth/usage').authorization,
      'Bearer claude-test-token',
    );

    // Crossing 90% raises one notification per limit.
    await page.getByRole('button', { name: /^Notifications/ }).click();
    const notifications = page.locator('.notification-popover');
    await notifications.waitFor();
    assert.equal(await notifications.getByText('Claude 5-hour usage at 92%').count(), 1);
    assert.equal(
      await notifications.getByText(/Claude weekly/).count(),
      0,
      '30% is below the first warning',
    );
    await page.keyboard.press('Escape');

    const claude = dashboard.locator('.usage-card[data-provider="claude"]');
    assert.match(await claude.textContent(), /Updated just now/);
    assert.equal(
      await claude.getByRole('meter', { name: '5-hour usage' }).getAttribute('aria-valuenow'),
      '92',
    );
    assert.equal(
      await claude.getByRole('meter', { name: 'Opus weekly usage' }).getAttribute('aria-valuenow'),
      '50',
    );
    // The current dashboard warns at high usage and shows the elapsed marker.
    assert.match(await claude.textContent(), /Almost out of usage/);
    assert.match(
      await claude.locator('.usage-meter-track').first().getAttribute('title'),
      /60% of the window has passed/,
    );
    const codex = dashboard.locator('.usage-card[data-provider="codex"]');
    assert.match(await codex.textContent(), /From last Codex reply/);
    assert.match(await codex.textContent(), /Sign-in expired\. Start Codex to refresh it\./);
    assert.equal(
      await codex.getByRole('meter', { name: 'Weekly usage' }).getAttribute('aria-valuenow'),
      '93',
    );
    assert.equal(
      await codex.locator('.usage-meter-warning').count(),
      0,
      'old readings must not project current use',
    );
    assert.match(await claude.textContent(), /5-hour92%/);
    assert.match(await claude.locator('.usage-card-status').textContent(), /Live/);
    assert.match(await codex.locator('.usage-card-status').textContent(), /Last known/);
    assert.equal(
      await dashboard.getByRole('button', { name: 'Refresh usage', exact: true }).isDisabled(),
      true,
      'the cooldown is visible and prevents ineffective clicks',
    );
    await page.screenshot({ path: path.join(artifacts, 'usage-live.png') });

    // Opening the dashboard and polling share one cached reading.
    await page.waitForTimeout(2500);
    const claudeRequests = requests.filter((request) => request.url === '/api/oauth/usage').length;
    assert.ok(claudeRequests <= 2, `expected at most 2 Claude requests, saw ${claudeRequests}`);

    // After a restart the last reading shows at once, even when the service is down.
    await app.close();
    claudeStatus = 503;
    app = await launch();
    page = await app.firstWindow();
    await page.locator('.app').waitFor();
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await page.getByRole('tab', { name: 'Usage' }).click();
    const restored = page.locator('.usage-card[data-provider="claude"]');
    await restored.getByRole('meter', { name: '5-hour usage' }).waitFor({ timeout: 20000 });
    assert.equal(
      await restored.getByRole('meter', { name: '5-hour usage' }).getAttribute('aria-valuenow'),
      '92',
    );
    await page.waitForFunction(() =>
      document
        .querySelector('.usage-card[data-provider="claude"]')
        ?.textContent?.includes('answered 503'),
    );
    assert.match(await restored.getAttribute('class'), /status-stale/);
    await page.getByRole('button', { name: /^Notifications/ }).click();
    assert.equal(
      await page.locator('.notification-popover').getByText('Claude 5-hour usage at 92%').count(),
      1,
      'a warning is not repeated after a restart',
    );
    await page.keyboard.press('Escape');
    assert.match(await restored.textContent(), /Last known reading/);
    assert.equal(await restored.locator('.usage-meter-warning').count(), 0);
    await page.screenshot({ path: path.join(artifacts, 'usage-offline.png') });

    // Exercise renderer recovery separately from the real service scenarios above.
    // The bridge stays intact; only its test main-process handler changes.
    const setReading = async (fixture, failRefresh = false, afterRefresh = null) => {
      await app.evaluate(
        ({ ipcMain }, { fixture, failRefresh, afterRefresh }) => {
          globalThis.__usageTestChecks = 0;
          ipcMain.removeHandler('usage:get');
          ipcMain.handle('usage:get', async (_event, mode) => {
            if (mode !== 'cached') globalThis.__usageTestChecks++;
            if (mode === 'force') {
              await new Promise((resolve) => setTimeout(resolve, 800));
              if (failRefresh) throw new Error('test usage bridge failure');
              if (afterRefresh) fixture = afterRefresh;
            }
            return fixture;
          });
        },
        { fixture, failRefresh, afterRefresh },
      );
    };
    const pendingFixture = {
      claude: {
        provider: 'claude',
        status: 'ok',
        plan: 'pro',
        updatedAt: Date.now(),
        fiveHour: { percent: 100, resetsAt: Date.now() - 1000, resetPending: true },
        weekly: null,
      },
      codex: {
        provider: 'codex',
        status: 'expired',
        plan: null,
        fiveHour: null,
        weekly: null,
        message: 'Sign-in expired. Start Codex to refresh it.',
      },
    };
    await setReading(pendingFixture);
    await page.reload();
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await page.getByRole('tab', { name: 'Usage' }).click();
    await page.locator('.usage-panel').waitFor();
    assert.match(await page.locator('.usage-panel').textContent(), /Reset passed.*awaiting update/);
    assert.equal(
      await page.locator('.usage-card[data-provider="claude"]').getByRole('meter').count(),
      0,
    );
    assert.equal(await page.locator('.usage-meter-warning').count(), 0);
    assert.match(
      await page.locator('.usage-card[data-provider="codex"]').textContent(),
      /Sign-in expired/,
    );
    await page.screenshot({ path: path.join(artifacts, 'usage-awaiting-update.png') });

    const liveFixture = {
      ...pendingFixture,
      claude: {
        ...pendingFixture.claude,
        fiveHour: { percent: 25, resetsAt: Date.now() + 3_600_000 },
      },
    };
    await setReading(liveFixture, true);
    await page.reload();
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await page.getByRole('tab', { name: 'Usage' }).click();
    const refresh = page.getByRole('button', { name: 'Refresh usage', exact: true });
    await refresh.click();
    assert.equal(await refresh.isDisabled(), true, 'refresh cannot be clicked again while loading');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByRole('status').filter({ hasText: 'Usage could not be refreshed' }).waitFor();
    assert.equal(await refresh.isEnabled(), true);
    assert.equal(
      await app.evaluate(() => globalThis.__usageTestChecks),
      2,
      'overlapping refresh and visibility checks share one request',
    );
    assert.equal(
      await page
        .locator('.usage-card[data-provider="claude"]')
        .getByRole('meter')
        .getAttribute('aria-valuenow'),
      '25',
    );
    assert.match(
      await page.locator('.usage-card[data-provider="claude"]').getAttribute('class'),
      /status-stale/,
    );
    await setReading(liveFixture);
    await refresh.click();
    await page.waitForFunction(() => !document.querySelector('.usage-panel-error'));
    await page.waitForFunction(() =>
      document
        .querySelector('.usage-card[data-provider="claude"]')
        ?.classList.contains('status-ok'),
    );

    const signedOutFixture = Object.fromEntries(
      ['claude', 'codex'].map((provider) => [
        provider,
        {
          provider,
          status: 'signed-out',
          plan: null,
          fiveHour: null,
          weekly: null,
          message: `Sign in to ${provider === 'claude' ? 'Claude Code' : 'Codex with ChatGPT'} to see plan usage.`,
        },
      ]),
    );
    await setReading(signedOutFixture);
    await refresh.click();
    await page.waitForFunction(
      () => document.querySelectorAll('.usage-card.status-signed-out').length === 2,
    );
    assert.equal(await page.locator('.usage-panel').getByRole('meter').count(), 0);
    assert.match(await page.locator('.usage-panel').textContent(), /Sign in to Codex with ChatGPT/);
    assert.equal(await page.locator('.usage-indicator').count(), 0);
    await page.screenshot({ path: path.join(artifacts, 'usage-sign-in.png') });

    // Recheck promptly after reset, while honoring cooldowns and visibility.
    const clockAt = Date.now();
    await page.clock.install({ time: new Date(clockAt) });
    const beforeReset = {
      ...signedOutFixture,
      claude: {
        provider: 'claude',
        status: 'ok',
        plan: 'pro',
        updatedAt: clockAt,
        refreshAt: clockAt + 30_000,
        fiveHour: { percent: 100, resetsAt: clockAt + 1000 },
        weekly: null,
      },
    };
    const afterReset = {
      ...beforeReset,
      claude: {
        ...beforeReset.claude,
        updatedAt: clockAt + 30_000,
        refreshAt: clockAt + 60_000,
        fiveHour: { percent: 2, resetsAt: clockAt + 5 * 3_600_000 },
      },
    };
    await setReading(beforeReset, false, afterReset);
    await page.reload();
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await page.getByRole('tab', { name: 'Usage' }).click();
    await page.locator('.usage-card[data-provider="claude"]').getByRole('meter').waitFor();
    await page.clock.runFor(6000);
    assert.match(
      await page.locator('.usage-card[data-provider="claude"]').textContent(),
      /awaiting update/,
    );
    assert.equal(
      await app.evaluate(() => globalThis.__usageTestChecks),
      1,
      'the reset waits out the provider cooldown',
    );
    await page.clock.runFor(30_000);
    await page.waitForFunction(
      () =>
        document
          .querySelector('.usage-card[data-provider="claude"] [role="meter"]')
          ?.getAttribute('aria-valuenow') === '2',
    );
    assert.equal(
      await app.evaluate(() => globalThis.__usageTestChecks),
      2,
      'the reset refresh precedes the three-minute idle poll',
    );
    await page.evaluate(() =>
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }),
    );
    await page.clock.runFor(3 * 60_000);
    assert.equal(
      await app.evaluate(() => globalThis.__usageTestChecks),
      2,
      'hidden windows pause usage polling',
    );
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => !document.querySelector('.usage-panel-refresh.loading'));
    assert.equal(
      await app.evaluate(() => globalThis.__usageTestChecks),
      3,
      'usage refreshes when the app becomes visible',
    );
    const specificWindows = {
      claude: {
        provider: 'claude',
        status: 'unsupported',
        plan: null,
        fiveHour: null,
        weekly: null,
        message: 'Plan usage does not apply to API-key or cloud-provider sessions.',
      },
      codex: {
        provider: 'codex',
        status: 'ok',
        plan: 'free',
        fiveHour: null,
        weekly: null,
        accountKey: 'new-account',
        updatedAt: clockAt,
        extras: [
          {
            id: 'daily',
            label: '1-day',
            window: { percent: 40, resetsAt: clockAt + 24 * 3600000, durationMs: 86400000 },
          },
          {
            id: 'base_model_inference:weekly',
            label: 'Luna Reserve Weekly',
            window: { percent: 12, resetsAt: clockAt + 7 * 86400000, durationMs: 604800000 },
          },
        ],
      },
    };
    await setReading(specificWindows);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send('usage:changed'),
    );
    await page.clock.runFor(5000);
    await page.locator('.usage-card.status-unsupported').waitFor();
    assert.match(
      await page.locator('.usage-card[data-provider="claude"]').textContent(),
      /Not applicable/,
    );
    assert.equal(
      await page.locator('.usage-card[data-provider="claude"]').getByRole('meter').count(),
      0,
    );
    assert.equal(
      await page.getByRole('meter', { name: '1-day usage' }).getAttribute('aria-valuenow'),
      '40',
    );
    assert.equal(
      await page
        .getByRole('meter', { name: 'Luna Reserve Weekly usage' })
        .getAttribute('aria-valuenow'),
      '12',
    );
    assert.equal(
      await app.evaluate(() => globalThis.__usageTestChecks),
      1,
      'usage notifications request a full snapshot',
    );
    await page.screenshot({ path: path.join(artifacts, 'usage-account-types.png') });
    console.log(
      'Usage readings, reset confirmation, alerts, caching, restore, sign-in guidance, and refresh recovery passed.',
    );
  } finally {
    await app.close().catch(() => {});
    server.close();
    assert.ok(path.basename(dataDir).startsWith('superapp-usage-'));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
