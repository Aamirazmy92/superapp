const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

/*
 * Parsers, compatibility readers, and an account-aware usage cache. Production
 * readers use the CLIs' authenticated interfaces (usage-adapters.cjs). The
 * compatibility readers never refresh or rewrite CLI credentials.
 */
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const UNRECOGNISED = 'The usage reply had no recognised limits. Its format may have changed.';
const REQUEST_TIMEOUT_MS = 10_000;
// Anthropic's usage endpoint rate-limits after a few dozen checks in a short time.
const CACHE_MS = 60_000;
const FORCED_MIN_MS = 30_000;
const DEFAULT_RETRY_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const SNAPSHOT_TAIL_BYTES = 256 * 1024;
const SNAPSHOT_FILES = 8;

// Opaque identifiers only: tokens, email addresses and paths never cross IPC.
function accountKey(provider, home, ...identity) {
  return createHash('sha256')
    .update(JSON.stringify([provider, path.resolve(home), ...identity]))
    .digest('hex');
}
function tokenSubject(token) {
  try {
    const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}
function hasWindows(value) {
  return !!(value?.fiveHour || value?.weekly || value?.extras?.length);
}
function windowLabel(seconds) {
  if (seconds === 604800) return 'Weekly';
  if (seconds % 86400 === 0) return `${seconds / 86400}-day`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  return seconds % 60 === 0 ? `${seconds / 60}-minute` : `${seconds}-second`;
}

function positiveNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function percent(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : null;
}
function time(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
function claudeWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const used = percent(window.utilization);
  return used === null ? null : { percent: used, resetsAt: time(window.resets_at) };
}
// Max plans also have separate weekly limits per model.
const claudeExtras = [
  { id: 'oauth-apps', key: 'seven_day_oauth_apps', label: 'OAuth apps weekly' },
  { id: 'opus', key: 'seven_day_opus', label: 'Opus weekly' },
  { id: 'sonnet', key: 'seven_day_sonnet', label: 'Sonnet weekly' },
];
function parseClaudeUsage(body) {
  const result = { fiveHour: claudeWindow(body?.five_hour), weekly: claudeWindow(body?.seven_day) };
  const extras = claudeExtras.flatMap(({ id, key, label }) => {
    const window = claudeWindow(body?.[key]);
    return window ? [{ id, label, window }] : [];
  });
  for (const [index, model] of (Array.isArray(body?.model_scoped)
    ? body.model_scoped
    : []
  ).entries()) {
    const window = claudeWindow(model);
    if (window && typeof model.display_name === 'string')
      extras.push({
        id: `model:${model.display_name}:${index}`,
        label: `${model.display_name} weekly`,
        window,
      });
  }
  return extras.length ? { ...result, extras } : result;
}

// Codex names its windows primary/secondary; which is which depends on the plan.
function codexWindows(windows, now) {
  const result = { fiveHour: null, weekly: null };
  for (const window of windows) {
    if (!window || typeof window !== 'object') continue;
    const seconds = positiveNumber(window.seconds);
    let used = percent(window.used);
    if (seconds === null || used === null) continue;
    let resetsAt = time(window.resetsAt);
    // A snapshot from before its window reset no longer describes current use,
    // and an unused window reports a full-length reset that has not started.
    const unstarted = used === 0 && Number(window.resetAfter) >= seconds - 60;
    if (unstarted) {
      used = 0;
      resetsAt = null;
    }
    const value = expireWindow({ percent: used, resetsAt }, now);
    if (seconds === 5 * 3600 && !result.fiveHour) result.fiveHour = value;
    else if (seconds === 7 * 86400 && !result.weekly) result.weekly = value;
    else {
      result.extras ||= [];
      result.extras.push({
        id: `window:${windows.indexOf(window)}`,
        label: windowLabel(seconds),
        window: { ...value, durationMs: seconds * 1000 },
      });
    }
  }
  return result;
}
function parseCodexUsage(body) {
  const limit = body?.rate_limit || {};
  return {
    plan: typeof body?.plan_type === 'string' ? body.plan_type : null,
    ...codexWindows(
      [limit.primary_window, limit.secondary_window].map(
        (window) =>
          window && {
            used: window.used_percent,
            seconds: window.limit_window_seconds,
            resetAfter: window.reset_after_seconds,
            resetsAt: window.reset_at,
          },
      ),
    ),
  };
}
function parseCodexSnapshot(limits, now) {
  return {
    plan: typeof limits?.plan_type === 'string' ? limits.plan_type : null,
    ...codexWindows(
      [limits?.primary, limits?.secondary].map(
        (window) =>
          window && {
            used: window.used_percent,
            seconds: positiveNumber(window.window_minutes) * 60,
            resetsAt: window.resets_at,
          },
      ),
      now,
    ),
  };
}

function parseCodexRateLimits(body, now) {
  const buckets = body?.rateLimitsByLimitId;
  const entries =
    buckets && typeof buckets === 'object' && !Array.isArray(buckets) && Object.keys(buckets).length
      ? Object.entries(buckets)
      : [['codex', body?.rateLimits]];
  const result = { plan: null, fiveHour: null, weekly: null };
  // Parse the main bucket first so it cannot overwrite other buckets' extras.
  entries.sort(([a], [b]) => Number(b === 'codex') - Number(a === 'codex'));
  for (const [id, bucket] of entries) {
    if (!bucket || typeof bucket !== 'object') continue;
    const parsed = codexWindows(
      [bucket.primary, bucket.secondary].map(
        (window) =>
          window && {
            used: window.usedPercent,
            seconds: positiveNumber(window.windowDurationMins) * 60,
            resetsAt: window.resetsAt,
          },
      ),
      now,
    );
    if (typeof bucket.planType === 'string') result.plan ||= bucket.planType;
    if (id === 'codex') {
      Object.assign(result, parsed, {
        plan: typeof bucket.planType === 'string' ? bucket.planType : null,
      });
    } else {
      result.extras ||= [];
      const alias = (typeof bucket.limitName === 'string' && bucket.limitName.trim()) || id;
      // Quota aliases such as gpt-reserve report their actual model separately.
      // Use that metadata, never a fixed model mapping or the selected chat model.
      const model = typeof bucket.normalModelSlug === 'string' && bucket.normalModelSlug.trim();
      const reserve = /reserve/i.test(alias);
      const family = reserve && /^gpt-\d+(?:\.\d+)*-([a-z][a-z0-9-]*)$/i.exec(model || '')?.[1];
      const displayModel = family
        ? family.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
        : model;
      const name = displayModel ? `${displayModel}${reserve ? ' Reserve' : ''}` : alias;
      for (const [key, label, durationMs] of [
        ['fiveHour', '5-hour', 18000000],
        ['weekly', 'Weekly', 604800000],
      ])
        if (parsed[key])
          result.extras.push({
            id: `${id}:${key}`,
            label: `${name} ${label}`,
            window: { ...parsed[key], durationMs },
          });
      for (const extra of parsed.extras || [])
        result.extras.push({ ...extra, id: `${id}:${extra.id}`, label: `${name} ${extra.label}` });
    }
  }
  return result;
}

async function sortedEntries(folder) {
  try {
    return (await fs.readdir(folder)).sort().reverse();
  } catch {
    return [];
  }
}
async function readTail(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, SNAPSHOT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}
// Codex records the server's rate-limit headers in its session log after each reply.
async function latestCodexSnapshot(codexHome, now, expectedIdentity) {
  const sessions = path.join(codexHome, 'sessions');
  const days = [];
  // Sessions that run past midnight keep writing to the previous day's folder.
  scan: for (const year of await sortedEntries(sessions))
    for (const month of await sortedEntries(path.join(sessions, year)))
      for (const day of await sortedEntries(path.join(sessions, year, month))) {
        days.push(path.join(sessions, year, month, day));
        if (days.length === 2) break scan;
      }
  const files = [];
  for (const folder of days)
    for (const name of await sortedEntries(folder)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(folder, name);
      try {
        files.push({ file, mtime: (await fs.stat(file)).mtimeMs });
      } catch {
        /* Removed while scanning. */
      }
    }
  files.sort((a, b) => b.mtime - a.mtime);
  let best = null;
  for (const { file } of files.slice(0, SNAPSHOT_FILES)) {
    let text;
    try {
      text = await readTail(file);
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
      if (!lines[index].includes('"rate_limits"')) continue;
      let entry;
      try {
        entry = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      const limits = entry?.payload?.rate_limits;
      // Old logs without identity cannot be attributed to the current account.
      if (
        expectedIdentity !== undefined &&
        (!expectedIdentity?.accountId ||
          !expectedIdentity?.userId ||
          (limits?.account_id || entry?.payload?.account_id) !== expectedIdentity.accountId ||
          (limits?.user_id || entry?.payload?.user_id) !== expectedIdentity.userId)
      )
        continue;
      const observedAt = time(entry?.timestamp);
      if (!limits || observedAt === null) continue;
      const parsed = parseCodexSnapshot(limits, now);
      if (!hasWindows(parsed)) continue;
      if (!best || observedAt > best.observedAt) best = { ...parsed, observedAt };
      break;
    }
  }
  return best;
}

async function readJSON(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
function retryDelay(response, at) {
  const value = response.headers?.get?.('retry-after');
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) && date > at ? date - at : DEFAULT_RETRY_MS;
}
async function request(fetch, url, headers, now) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Veyo', ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401) return { expired: true };
  if (response.status === 403)
    return { error: 'This sign-in does not have permission to read plan usage.' };
  if (response.status === 429)
    return {
      error: 'The provider is limiting how often usage can be checked.',
      retryAfterMs: retryDelay(response, now()),
    };
  if (!response.ok) return { error: `The usage service answered ${response.status}.` };
  return { body: await response.json() };
}
/*
 * Tests point both endpoints at a local server. Only a bare loopback origin is
 * accepted, so the saved sign-ins can never be sent anywhere else.
 */
function endpoint(url, testOrigin) {
  if (!testOrigin) return url;
  try {
    const origin = new URL(testOrigin);
    if (
      origin.protocol === 'http:' &&
      origin.hostname === '127.0.0.1' &&
      origin.origin === testOrigin
    )
      return origin.origin + new URL(url).pathname;
  } catch {
    /* Not a URL; use the real endpoint. */
  }
  return url;
}
function failure(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError'
    ? 'The usage service did not answer in time.'
    : 'Usage could not be reached. Check your connection.';
}

async function readClaudeUsage({
  configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  fetch = globalThis.fetch,
  now = Date.now,
  testOrigin = process.env.VEYO_USAGE_TEST_ORIGIN,
} = {}) {
  const base = { provider: 'claude', plan: null, fiveHour: null, weekly: null };
  const oauth = (await readJSON(path.join(configDir, '.credentials.json')))?.claudeAiOauth;
  if (!oauth?.accessToken)
    return { ...base, status: 'signed-out', message: 'Sign in to Claude Code to see plan usage.' };
  const plan = typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null;
  const expired = {
    ...base,
    plan,
    status: 'expired',
    message: 'Sign-in expired. Start Claude Code to refresh it.',
  };
  if (Number(oauth.expiresAt) && Number(oauth.expiresAt) <= now()) return expired;
  let result;
  try {
    result = await request(
      fetch,
      endpoint(CLAUDE_USAGE_URL, testOrigin),
      {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      now,
    );
  } catch (error) {
    return { ...base, plan, status: 'error', message: failure(error) };
  }
  if (result.expired) return expired;
  if (result.error)
    return {
      ...base,
      plan,
      status: 'error',
      message: result.error,
      retryAfterMs: result.retryAfterMs,
    };
  const parsed = parseClaudeUsage(result.body);
  if (!hasWindows(parsed)) return { ...base, plan, status: 'error', message: UNRECOGNISED };
  return { ...base, plan, ...parsed, status: 'ok', source: 'live', updatedAt: now() };
}

async function readCodexUsage({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  fetch = globalThis.fetch,
  now = Date.now,
  testOrigin = process.env.VEYO_USAGE_TEST_ORIGIN,
} = {}) {
  const base = { provider: 'codex', plan: null, fiveHour: null, weekly: null };
  const auth = await readJSON(path.join(codexHome, 'auth.json'));
  const token = auth?.tokens?.access_token;
  if (auth?.auth_mode === 'apikey' || auth?.OPENAI_API_KEY)
    return {
      ...base,
      status: 'unsupported',
      message: 'Plan usage does not apply to API-key sessions.',
    };
  if (!token || (auth.auth_mode && auth.auth_mode !== 'chatgpt'))
    return {
      ...base,
      status: 'signed-out',
      message: 'Sign in to Codex with ChatGPT to see plan usage.',
    };
  let result;
  try {
    const headers = { Authorization: `Bearer ${token}` };
    if (auth.tokens.account_id) headers['ChatGPT-Account-Id'] = auth.tokens.account_id;
    result = await request(fetch, endpoint(CODEX_USAGE_URL, testOrigin), headers, now);
  } catch (error) {
    result = { error: failure(error) };
  }
  if (result.body) {
    const parsed = parseCodexUsage(result.body);
    if (hasWindows(parsed))
      return { ...base, ...parsed, status: 'ok', source: 'live', updatedAt: now() };
    result = { error: UNRECOGNISED };
  }
  const snapshot = await latestCodexSnapshot(codexHome, now(), {
    accountId: auth.tokens.account_id,
    userId: tokenSubject(auth.tokens.id_token || token),
  });
  if (snapshot) {
    const { observedAt, ...windows } = snapshot;
    return {
      ...base,
      ...windows,
      status: 'stale',
      source: 'session-log',
      updatedAt: observedAt,
      message: result.expired ? 'Sign-in expired. Start Codex to refresh it.' : result.error,
      retryAfterMs: result.retryAfterMs,
    };
  }
  if (result.expired)
    return { ...base, status: 'expired', message: 'Sign-in expired. Start Codex to refresh it.' };
  return { ...base, status: 'error', message: result.error, retryAfterMs: result.retryAfterMs };
}

function expireWindow(window, at) {
  return window?.resetsAt && window.resetsAt <= at ? { ...window, resetPending: true } : window;
}
// A reading kept past its window's reset time describes a window that has ended.
function expire(value, at) {
  return {
    ...value,
    fiveHour: expireWindow(value.fiveHour, at),
    weekly: expireWindow(value.weekly, at),
    ...(value.extras && {
      extras: value.extras.map((extra) => ({ ...extra, window: expireWindow(extra.window, at) })),
    }),
  };
}

// Cache files are local data, but an interrupted write or older schema should
// never turn a broken value into a working meter or crash the dashboard.
function restoredReading(value, key) {
  if (!value || value.provider !== key) return null;
  const window = (item) => {
    if (!item || typeof item.percent !== 'number' || !Number.isFinite(item.percent)) return null;
    return {
      percent: percent(item.percent),
      resetsAt:
        typeof item.resetsAt === 'number' && Number.isFinite(item.resetsAt) && item.resetsAt > 0
          ? item.resetsAt
          : null,
      ...(typeof item.durationMs === 'number' &&
        Number.isFinite(item.durationMs) &&
        item.durationMs > 0 && { durationMs: item.durationMs }),
    };
  };
  const fiveHour = window(value.fiveHour);
  const weekly = window(value.weekly);
  const extras = Array.isArray(value.extras)
    ? value.extras.flatMap((extra) => {
        const reading = window(extra?.window);
        return reading && typeof extra.id === 'string' && typeof extra.label === 'string'
          ? [{ id: extra.id, label: extra.label, window: reading }]
          : [];
      })
    : [];
  if (!fiveHour && !weekly && !extras.length) return null;
  return {
    provider: key,
    ...(typeof value.accountKey === 'string' &&
      /^[a-f0-9]{64}$/.test(value.accountKey) && { accountKey: value.accountKey }),
    status: 'stale',
    fiveHour,
    weekly,
    plan: typeof value.plan === 'string' ? value.plan : null,
    source: value.source === 'session-log' ? 'session-log' : 'live',
    ...(typeof value.updatedAt === 'number' &&
      Number.isFinite(value.updatedAt) && { updatedAt: value.updatedAt }),
    ...(extras.length && { extras }),
  };
}

/*
 * One reading per provider, shared by every caller: cached for CACHE_MS,
 * forced reads no more often than FORCED_MIN_MS, and a rate-limited provider
 * is left alone until its retry delay passes. The last good readings are
 * restored with load() and handed to save() so a restart shows them at once.
 */
function createUsageService({
  now = Date.now,
  fetch = globalThis.fetch,
  readers = {
    claude: () => readClaudeUsage({ fetch, now }),
    codex: () => readCodexUsage({ fetch, now }),
  },
  // A context validates local identity even when returning a cached value.
  // It owns any temporary CLI connection and is always disposed below.
  contexts = {},
  load = async () => null,
  save = async () => {},
} = {}) {
  const entries = new Map(
    Object.keys(readers).map((key) => [
      key,
      {
        value: null,
        lastGood: null,
        fetchedAt: -Infinity,
        blockedUntil: 0,
        limited: 0,
        pending: null,
        pendingCached: false,
        scope: undefined,
      },
    ]),
  );
  let saveQueue = Promise.resolve();
  const ready = Promise.resolve()
    .then(load)
    .then((saved) => {
      for (const [key, entry] of entries) {
        const value = restoredReading(saved?.[key], key);
        if (!value) continue;
        entry.lastGood = value;
        entry.value = { ...value, status: 'stale' };
      }
    })
    .catch(() => {});
  function persist() {
    const saved = {};
    for (const [key, entry] of entries) if (entry.lastGood) saved[key] = entry.lastGood;
    saveQueue = saveQueue.then(() => save(saved)).catch(() => {});
    return saveQueue;
  }
  async function refresh(key, entry, context) {
    let value;
    try {
      value = await readers[key](context);
    } catch {
      value = { provider: key, status: 'error', message: 'Usage could not be read.' };
    }
    const at = now();
    if (context) value = { ...value, accountKey: context.accountKey || undefined };
    if (context && entry.lastGood && entry.lastGood.accountKey !== context.accountKey) {
      entry.lastGood = null;
      await persist();
    }
    entry.fetchedAt = at;
    // Each rate limit in a row doubles the wait; any other answer resets it.
    entry.limited = value.retryAfterMs ? entry.limited + 1 : 0;
    entry.blockedUntil = value.retryAfterMs
      ? at +
        Math.max(
          value.retryAfterMs,
          Math.min(MAX_BACKOFF_MS, value.retryAfterMs * 2 ** (entry.limited - 1)),
        )
      : 0;
    const { retryAfterMs, ...shown } = value;
    if (shown.status === 'signed-out' || shown.status === 'unsupported') {
      const hadReading = !!entry.lastGood;
      entry.lastGood = null;
      if (hadReading) await persist();
    } else if (hasWindows(shown) && (!context || context.accountKey)) {
      // A fallback log can be older than the last live response.
      if (shown.status === 'stale' && entry.lastGood?.updatedAt > shown.updatedAt)
        Object.assign(shown, entry.lastGood, { status: 'stale', message: value.message });
      entry.lastGood = shown;
      await persist();
    }
    entry.value =
      (shown.status === 'error' || shown.status === 'expired') && entry.lastGood
        ? { ...entry.lastGood, status: 'stale', message: shown.message }
        : shown;
    if (entry.blockedUntil) entry.value = { ...entry.value, retryAt: entry.blockedUntil };
    return entry.value;
  }
  async function checkContext(key, entry) {
    if (!contexts[key]) return undefined;
    const context = await contexts[key]();
    const scope = context.accountKey || null;
    const changed = entry.scope !== undefined && entry.scope !== scope;
    const unverified = !scope;
    const invalidSaved = entry.lastGood && entry.lastGood.accountKey !== scope;
    if (changed || unverified || invalidSaved || context.result) {
      const hadReading = !!entry.lastGood;
      entry.lastGood = null;
      entry.value = null;
      if (changed) {
        entry.fetchedAt = -Infinity;
        entry.blockedUntil = 0;
        entry.limited = 0;
      }
      if (hadReading) await persist();
    }
    entry.scope = scope;
    return context;
  }
  function read(key, force, cached = false) {
    const entry = entries.get(key);
    if (entry.pending)
      return !cached && entry.pendingCached
        ? entry.pending.then(() => read(key, force, false))
        : entry.pending;
    entry.pendingCached = cached;
    entry.pending = (async () => {
      let context;
      try {
        context = await checkContext(key, entry);
        if (context?.result) {
          entry.value = {
            provider: key,
            plan: null,
            fiveHour: null,
            weekly: null,
            ...context.result,
            accountKey: context.accountKey || undefined,
          };
          return entry.value;
        }
        if (cached) return entry.value;
        return await readCurrent(key, entry, force, context);
      } catch {
        // An identity that could not be checked must never expose cached meters.
        entry.value = null;
        entry.lastGood = null;
        await persist();
        return {
          provider: key,
          plan: null,
          fiveHour: null,
          weekly: null,
          status: 'error',
          message: 'The active sign-in could not be checked. Try again.',
        };
      } finally {
        context?.dispose?.();
      }
    })().finally(() => {
      entry.pending = null;
    });
    return entry.pending;
  }
  function readCurrent(key, entry, force, context) {
    const at = now();
    const resetPassed = [
      entry.value?.fiveHour,
      entry.value?.weekly,
      ...(entry.value?.extras || []).map((extra) => extra.window),
    ].some(
      (window) => window?.resetsAt && window.resetsAt <= at && entry.fetchedAt < window.resetsAt,
    );
    const fresh = at - entry.fetchedAt < (force || resetPassed ? FORCED_MIN_MS : CACHE_MS);
    if (entry.value && (fresh || at < entry.blockedUntil)) return Promise.resolve(entry.value);
    if (
      !entry.value &&
      context &&
      (at < entry.blockedUntil || at - entry.fetchedAt < FORCED_MIN_MS)
    )
      return {
        provider: key,
        plan: null,
        fiveHour: null,
        weekly: null,
        status: 'error',
        message: 'Current account usage is awaiting a new reading.',
        retryAt: entry.blockedUntil || undefined,
      };
    return refresh(key, entry, context);
  }
  return {
    async get({ force = false } = {}) {
      await ready;
      const keys = [...entries.keys()];
      const values = await Promise.all(keys.map((key) => read(key, force)));
      const at = now();
      return Object.fromEntries(
        keys.map((key, index) => [
          key,
          {
            ...expire(values[index], at),
            refreshAt: Math.max(
              entries.get(key).fetchedAt + FORCED_MIN_MS,
              entries.get(key).blockedUntil,
            ),
          },
        ]),
      );
    },
    /** Validate identity locally; never request fresh usage. */
    async peek() {
      await ready;
      const keys = [...entries.keys()];
      const values = await Promise.all(keys.map((key) => read(key, false, true)));
      const at = now();
      return Object.fromEntries(
        keys.flatMap((key, index) => (values[index] ? [[key, expire(values[index], at)]] : [])),
      );
    },
  };
}

module.exports = {
  parseClaudeUsage,
  parseCodexUsage,
  parseCodexSnapshot,
  parseCodexRateLimits,
  accountKey,
  tokenSubject,
  hasWindows,
  UNRECOGNISED,
  DEFAULT_RETRY_MS,
  latestCodexSnapshot,
  readClaudeUsage,
  readCodexUsage,
  createUsageService,
};
