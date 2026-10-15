const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  createUsageService,
  accountKey,
  parseCodexRateLimits,
  readCodexUsage,
} = require('../electron/usage.cjs');
const { createUsageAdapters, CLAUDE_USAGE_METHOD } = require('../electron/usage-adapters.cjs');

const NOW = Date.parse('2026-10-02T12:00:00Z');
const HOME = path.join(os.tmpdir(), 'usage-profile');
const A = accountKey('codex', HOME, 'person-a', 'workspace');
const B = accountKey('codex', HOME, 'person-b', 'workspace');
const good = (percent = 20) => ({
  provider: 'codex',
  status: 'ok',
  plan: 'plus',
  fiveHour: { percent, resetsAt: NOW + 3600000 },
  weekly: null,
  updatedAt: NOW,
});
async function temp(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'veyo-account-'));
  t.after(async () => {
    assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(folder, { recursive: true, force: true });
  });
  return folder;
}

test('Switching accounts invalidates a fresh cache and the previous account cooldown', async () => {
  let identity = A;
  let calls = 0;
  let saved;
  let reply = good();
  const service = createUsageService({
    now: () => NOW,
    contexts: { codex: async () => ({ accountKey: identity }) },
    readers: {
      codex: async () => {
        calls++;
        return reply;
      },
    },
    save: async (value) => {
      saved = value;
    },
  });
  assert.equal((await service.get()).codex.fiveHour.percent, 20);
  await service.get();
  assert.equal(calls, 1);
  identity = B;
  reply = { provider: 'codex', status: 'error', message: 'Offline', retryAfterMs: 300000 };
  const switched = await service.get();
  assert.equal(switched.codex.accountKey, B);
  assert.equal(switched.codex.status, 'error');
  assert.equal(switched.codex.fiveHour, undefined);
  assert.deepEqual(saved, {});
  identity = A;
  reply = good(35);
  assert.equal((await service.get()).codex.fiveHour.percent, 35);
  assert.equal(calls, 3, 'account B backoff does not block account A');
});

test('Restored readings are validated before peek and legacy unscoped caches are discarded', async () => {
  for (const identity of [A, B, null]) {
    for (const storedIdentity of [A, undefined]) {
      const service = createUsageService({
        contexts: { codex: async () => ({ accountKey: identity }) },
        readers: { codex: async () => assert.fail('peek must not request usage') },
        load: async () => ({ codex: { ...good(), accountKey: storedIdentity } }),
      });
      assert.equal(!!(await service.peek()).codex, identity === A && storedIdentity === A);
    }
  }
});

test('Identity check failures and sign-outs hide readings even within the cache window', async () => {
  let mode = 'ok';
  const service = createUsageService({
    now: () => NOW,
    contexts: {
      codex: async () => {
        if (mode === 'error') throw new Error('Secret CLI stderr');
        return {
          accountKey: mode === 'ok' ? A : null,
          ...(mode === 'out' && { result: { status: 'signed-out' } }),
        };
      },
    },
    readers: { codex: async () => good() },
  });
  await service.get();
  mode = 'error';
  const unknown = await service.peek();
  assert.equal(unknown.codex.status, 'error');
  assert.equal(unknown.codex.fiveHour, null);
  assert.equal(JSON.stringify(unknown).includes('Secret'), false);
  mode = 'ok';
  await service.get();
  mode = 'out';
  assert.equal((await service.get()).codex.status, 'signed-out');
});

test('Contexts are disposed on cached, live and failed reads; get cannot be swallowed by peek', async () => {
  let contexts = 0;
  let closed = 0;
  let reads = 0;
  const service = createUsageService({
    contexts: {
      codex: async () => {
        contexts++;
        await new Promise((resolve) => setImmediate(resolve));
        return { accountKey: A, dispose: () => closed++ };
      },
    },
    readers: {
      codex: async () => {
        reads++;
        return good();
      },
    },
  });
  const [cached, live] = await Promise.all([service.peek(), service.get()]);
  assert.equal(cached.codex, undefined);
  assert.equal(live.codex.status, 'ok');
  assert.equal(reads, 1);
  await service.get();
  assert.equal(reads, 1);
  assert.equal(closed, contexts);
});

test('An account change during a read cannot fall back to the previous meter', async () => {
  let switched = false;
  let clock = NOW;
  const service = createUsageService({
    now: () => clock,
    contexts: { codex: async () => ({ accountKey: A }) },
    readers: {
      codex: async (context) => {
        if (switched) {
          context.accountKey = null;
          throw new Error('changed');
        }
        return good();
      },
    },
  });
  await service.get();
  switched = true;
  clock += 61000;
  const value = (await service.get()).codex;
  assert.equal(value.status, 'error');
  assert.equal(value.fiveHour, undefined);
});

test('Codex parses daily windows and multiple buckets without losing duration or labels', () => {
  const parsed = parseCodexRateLimits(
    {
      rateLimitsByLimitId: {
        other: {
          limitName: 'Other model',
          primary: { usedPercent: 5, windowDurationMins: 15, resetsAt: (NOW + 60000) / 1000 },
        },
        codex: {
          planType: 'free',
          primary: { usedPercent: 40, windowDurationMins: 1440, resetsAt: (NOW + 3600000) / 1000 },
          secondary: null,
        },
      },
    },
    NOW,
  );
  assert.equal(parsed.fiveHour, null);
  assert.equal(parsed.weekly, null);
  assert.deepEqual(
    parsed.extras.map((item) => [item.label, item.window.durationMs]),
    [
      ['1-day', 86400000],
      ['Other model 15-minute', 900000],
    ],
  );
});

test('Codex reserve labels use the reported model and keep the quota identity', () => {
  for (const [model, label] of [
    ['gpt-5.6-luna', 'Luna'],
    ['gpt-6.1-astra', 'Astra'],
    ['gpt-5.6-codex-mini', 'Codex Mini'],
    ['gpt-5.6', 'gpt-5.6'],
    ['future-model', 'future-model'],
  ]) {
    const parsed = parseCodexRateLimits(
      {
        rateLimitsByLimitId: {
          base_model_inference: {
            limitName: 'gpt-reserve',
            normalModelSlug: ` ${model} `,
            primary: { usedPercent: 12, windowDurationMins: 300 },
            secondary: { usedPercent: 34, windowDurationMins: 10080 },
          },
        },
      },
      NOW,
    );
    assert.deepEqual(
      parsed.extras.map(({ id, label, window }) => [id, label, window.percent]),
      [
        ['base_model_inference:fiveHour', `${label} Reserve 5-hour`, 12],
        ['base_model_inference:weekly', `${label} Reserve Weekly`, 34],
      ],
    );
  }
});

test('Codex model aliases handle custom windows and absent model metadata', () => {
  for (const model of [undefined, null, '', ' ', 42]) {
    const parsed = parseCodexRateLimits({
      rateLimitsByLimitId: {
        reserve: {
          limitName: 'gpt-reserve',
          normalModelSlug: model,
          primary: { usedPercent: 12, windowDurationMins: 1440 },
        },
      },
    });
    assert.equal(parsed.extras[0].label, 'gpt-reserve 1-day', 'do not guess a model');
  }
  const parsed = parseCodexRateLimits({
    rateLimitsByLimitId: {
      reserve: {
        limitName: ' ',
        normalModelSlug: 'new-model',
        primary: { usedPercent: 12, windowDurationMins: 1440 },
      },
      other: {
        limitName: 'Model alias',
        normalModelSlug: 'another-model',
        primary: { usedPercent: 5, windowDurationMins: 15 },
      },
    },
  });
  assert.equal(parsed.extras[0].label, 'new-model Reserve 1-day');
  assert.equal(parsed.extras[0].window.durationMs, 86400000);
  assert.equal(parsed.extras[1].label, 'another-model 15-minute');
});

test('Unknown buckets retain names and malformed durations cannot create meters', () => {
  for (const value of [true, false, null, '', 'bad', -1]) {
    const parsed = parseCodexRateLimits(
      { rateLimits: { primary: { usedPercent: 10, windowDurationMins: value } } },
      NOW,
    );
    assert.equal(parsed.fiveHour, null);
    assert.equal(parsed.weekly, null);
    assert.equal(parsed.extras, undefined);
  }
  const parsed = parseCodexRateLimits(
    {
      rateLimitsByLimitId: {
        review: {
          limitName: 'Code review',
          planType: 'plus',
          primary: { usedPercent: 75, windowDurationMins: 10080 },
        },
      },
    },
    NOW,
  );
  assert.equal(parsed.plan, 'plus');
  assert.equal(parsed.extras[0].label, 'Code review Weekly');
});

test('Codex uses app-server authentication with keyring credentials and closes the connection', async (t) => {
  const folder = await temp(t);
  await fs.writeFile(path.join(folder, 'config.toml'), 'cli_auth_credentials_store = "keyring"');
  const calls = [];
  let closed = 0;
  let connections = 0;
  const adapters = createUsageAdapters({
    env: { CODEX_HOME: folder },
    now: () => NOW,
    findAgents: async () => [{ id: 'codex', executable: 'codex.exe' }],
    fetch: async () => assert.fail('app-server must handle auth, not fetch saved tokens'),
    connect: () => {
      connections++;
      return {
        initialize: async () => {},
        dispose: () => closed++,
        call: async (method, params) => {
          calls.push([method, params]);
          if (method === 'account/read')
            return { account: { type: 'chatgpt', email: 'user@example.test', planType: 'plus' } };
          if (method === 'config/read')
            return { config: { cli_auth_credentials_store: 'keyring' } };
          assert.equal(method, 'account/rateLimits/read');
          return {
            accountId: 'workspace',
            rateLimits: {
              planType: 'plus',
              primary: {
                usedPercent: 31,
                windowDurationMins: 300,
                resetsAt: (NOW + 3600000) / 1000,
              },
            },
          };
        },
      };
    },
  });
  const result = await createUsageService({ ...adapters, now: () => NOW }).get();
  assert.equal(result.codex.fiveHour.percent, 31);
  assert.match(result.codex.accountKey, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('user@example'), false);
  assert.deepEqual(calls[0], ['account/read', { refreshToken: false }]);
  assert.equal(closed, connections);
});

test('Claude reads SDK usage without sending a prompt and validates account identity', async (t) => {
  const folder = await temp(t);
  let closed = 0;
  let identity = 'alice@example.test';
  let switchDuringRead = false;
  const adapters = createUsageAdapters({
    env: { CLAUDE_CONFIG_DIR: folder, CODEX_HOME: folder },
    now: () => NOW,
    findAgents: async () => [{ id: 'claude', executable: 'claude.exe' }],
    readStatus: async () => ({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: identity,
      orgId: 'org',
      subscriptionType: 'pro',
    }),
    query: async ({ prompt, options }) => {
      assert.equal(typeof prompt[Symbol.asyncIterator], 'function');
      assert.deepEqual(options.tools, []);
      assert.equal(options.settings.disableAllHooks, true);
      return {
        close: () => closed++,
        [CLAUDE_USAGE_METHOD]: async (params) => {
          assert.deepEqual(params, { skipBehaviors: true });
          if (switchDuringRead) identity = 'bob@example.test';
          return {
            rate_limits_available: true,
            subscription_type: 'pro',
            rate_limits: {
              five_hour: { utilization: 42, resets_at: new Date(NOW + 3600000).toISOString() },
            },
          };
        },
      };
    },
  });
  const context = await adapters.contexts.claude();
  const result = await adapters.readers.claude(context);
  assert.equal(result.fiveHour.percent, 42);
  assert.equal(closed, 1);
  switchDuringRead = true;
  await assert.rejects(() => adapters.readers.claude(context), /changed/);
  assert.equal(context.accountKey, null);
  assert.equal(closed, 2);
});

test('Authenticated API-key and cloud sessions report not applicable', async (t) => {
  const folder = await temp(t);
  const adapters = createUsageAdapters({
    env: { CLAUDE_CONFIG_DIR: folder, CODEX_HOME: folder },
    findAgents: async () => [
      { id: 'claude', executable: 'claude.exe' },
      { id: 'codex', executable: 'codex.exe' },
    ],
    readStatus: async () => ({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }),
    query: async () => assert.fail('no SDK usage call for API keys'),
    connect: () => ({
      initialize: async () => {},
      dispose: () => {},
      call: async () => ({ account: { type: 'amazonBedrock' } }),
    }),
  });
  const result = await createUsageService(adapters).get();
  assert.equal(result.claude.status, 'unsupported');
  assert.equal(result.codex.status, 'unsupported');
});

test('Codex refuses unscoped and different-account session-log fallbacks', async (t) => {
  const folder = await temp(t);
  await fs.writeFile(
    path.join(folder, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'token', account_id: 'current' },
    }),
  );
  const day = path.join(folder, 'sessions', '2026', '10', '02');
  await fs.mkdir(day, { recursive: true });
  for (const accountId of [undefined, 'other']) {
    await fs.writeFile(
      path.join(day, 'rollout.jsonl'),
      JSON.stringify({
        timestamp: new Date(NOW).toISOString(),
        payload: {
          rate_limits: {
            account_id: accountId,
            primary: { used_percent: 50, window_minutes: 300, resets_at: (NOW + 3600000) / 1000 },
          },
        },
      }) + '\n',
    );
    const result = await readCodexUsage({
      codexHome: folder,
      now: () => NOW,
      fetch: async () => {
        throw new Error('offline');
      },
    });
    assert.equal(result.status, 'error');
    assert.equal(result.fiveHour, null);
  }
});

test('Keyring account switches with the same email invalidate cached workspace usage', async (t) => {
  const folder = await temp(t);
  let workspace = 'work';
  let calls = 0;
  let offline = false;
  const adapters = createUsageAdapters({
    env: { CODEX_HOME: folder, CLAUDE_CONFIG_DIR: folder },
    now: () => NOW,
    findAgents: async () => [{ id: 'codex', executable: 'codex.exe' }],
    connect: () => {
      const currentWorkspace = workspace;
      return {
        initialize: async () => {},
        dispose: () => {},
        call: async (method) => {
          if (method === 'account/read')
            return {
              account: { type: 'chatgpt', email: 'same-user@example.test', planType: 'plus' },
              workspaceRouting: {
                chatgptAccountId: currentWorkspace,
                backendOrigin: 'https://chatgpt.com',
              },
            };
          assert.equal(method, 'account/rateLimits/read');
          calls++;
          if (offline) throw new Error('offline');
          return {
            accountId: currentWorkspace,
            rateLimits: {
              primary: {
                usedPercent: 65,
                windowDurationMins: 300,
                resetsAt: (NOW + 3600000) / 1000,
              },
            },
          };
        },
      };
    },
  });
  const service = createUsageService({ ...adapters, now: () => NOW });
  const initial = (await service.get()).codex;
  assert.equal((await service.get()).codex.fiveHour.percent, 65);
  assert.equal(calls, 1, 'verified keyring identity uses the existing cooldown/cache');
  workspace = 'personal';
  offline = true;
  assert.equal(
    (await service.peek()).codex,
    undefined,
    'old workspace is hidden before requesting usage',
  );
  const switched = (await service.get()).codex;
  assert.equal(switched.status, 'error');
  assert.equal(switched.fiveHour, null);
  assert.notEqual(switched.accountKey, initial.accountKey);
});

test('Claude falls back for an unsupported SDK method but not malformed usage responses', async (t) => {
  if (process.platform === 'darwin') return;
  const folder = await temp(t);
  await fs.writeFile(
    path.join(folder, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'test', expiresAt: NOW + 3600000 } }),
  );
  let malformed = false;
  let requests = 0;
  let closes = 0;
  const adapters = createUsageAdapters({
    env: { CLAUDE_CONFIG_DIR: folder, CODEX_HOME: folder },
    now: () => NOW,
    findAgents: async () => [{ id: 'claude', executable: 'claude.exe' }],
    readStatus: async () => ({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'user@example.test',
      orgId: 'org',
    }),
    query: async () => ({
      close: () => closes++,
      ...(malformed && {
        [CLAUDE_USAGE_METHOD]: async () => ({ rate_limits_available: true, rate_limits: {} }),
      }),
    }),
    fetch: async () => {
      requests++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 23, resets_at: new Date(NOW + 3600000).toISOString() },
        }),
      };
    },
  });
  let context = await adapters.contexts.claude();
  assert.equal((await adapters.readers.claude(context)).fiveHour.percent, 23);
  malformed = true;
  context = await adapters.contexts.claude();
  assert.equal((await adapters.readers.claude(context)).status, 'error');
  assert.equal(requests, 1, 'a failed SDK usage response does not cause another provider request');
  assert.equal(closes, 2);
});

test('Windows npm Codex shims launch their JS entry point without using a shell', async (t) => {
  const folder = await temp(t);
  const bin = path.join(folder, 'CLI with spaces');
  const entry = path.join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(
    entry,
    `
    const readline = require('node:readline');
    if (process.argv[2] !== 'app-server') process.exit(2);
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.id == null) return;
      const result = request.method === 'account/read' ? { account: { type: 'apiKey' }, requiresOpenaiAuth: true } : {};
      process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
    });
  `,
  );
  const adapters = createUsageAdapters({
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: folder,
      CODEX_HOME: folder,
      VEYO_USAGE_TEST_ORIGIN: '',
    },
    findAgents: async () => [{ id: 'codex', executable: path.join(bin, 'codex.cmd') }],
  });
  assert.equal((await createUsageService(adapters).get()).codex.status, 'unsupported');
});

test('Forbidden usage is permission-denied, not an expired sign-in', async (t) => {
  const folder = await temp(t);
  await fs.writeFile(
    path.join(folder, 'auth.json'),
    JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'token' } }),
  );
  const result = await readCodexUsage({
    codexHome: folder,
    fetch: async () => ({ status: 403 }),
    now: () => NOW,
  });
  assert.equal(result.status, 'error');
  assert.match(result.message, /permission/);
});

test('Repeated reads of an empty profile retain sign-in guidance without a cooldown error', async (t) => {
  const folder = await temp(t);
  const adapters = createUsageAdapters({
    env: { CLAUDE_CONFIG_DIR: folder, CODEX_HOME: folder },
    findAgents: async () => [],
  });
  const service = createUsageService(adapters);
  for (const method of ['peek', 'get', 'get', 'peek']) {
    const readings = await service[method]();
    assert.equal(readings.claude.status, 'signed-out');
    assert.equal(readings.codex.status, 'signed-out');
  }
});
