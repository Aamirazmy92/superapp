const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { listAgents } = require('./agents.cjs');
const { CodexConnection } = require('./agent-chat.cjs');
const {
  accountKey,
  tokenSubject,
  hasWindows,
  parseClaudeUsage,
  parseCodexRateLimits,
  readClaudeUsage,
  readCodexUsage,
  UNRECOGNISED,
  DEFAULT_RETRY_MS,
} = require('./usage.cjs');

const TIMEOUT_MS = 10000;
const CLAUDE_USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
const unsupported = {
  status: 'unsupported',
  message: 'Plan usage does not apply to API-key or cloud-provider sessions.',
};

async function optionalJSON(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function safeError(error) {
  const message = String(error?.message || '');
  if (/429|too many requests|rate.?limit/i.test(message))
    return {
      status: 'error',
      message: 'The provider is limiting how often usage can be checked.',
      retryAfterMs: DEFAULT_RETRY_MS,
    };
  if (/401|unauthorized|expired|not authenticated/i.test(message))
    return { status: 'expired', message: 'Sign-in expired. Start the CLI to refresh it.' };
  if (/403|forbidden|permission/i.test(message))
    return {
      status: 'error',
      message: 'This sign-in does not have permission to read plan usage.',
    };
  return {
    status: 'error',
    message: 'Plan usage could not be read. Check your connection and CLI sign-in.',
  };
}
async function deadline(task, cancel) {
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          cancel?.();
          reject(new Error('Usage timed out.'));
        }, TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Launch npm CLIs through their known JS entry point, never through a shell or
// project-local shim. This also works in packaged Electron with runAsNode.
async function cliEntry(command, provider) {
  if (!/\.(cmd|bat|ps1)$/i.test(command)) return command;
  const relative =
    provider === 'codex' ? '@openai/codex/bin/codex.js' : '@anthropic-ai/claude-code/cli.js';
  const entry = path.join(path.dirname(command), 'node_modules', relative);
  await fs.access(entry);
  return entry;
}
function authStatus(command, env) {
  const script = /\.[cm]?js$/i.test(command);
  return new Promise((resolve, reject) => {
    execFile(
      script ? process.execPath : command,
      [...(script ? [command] : []), 'auth', 'status', '--json'],
      {
        cwd: os.homedir(),
        env: { ...env, ...(script && { ELECTRON_RUN_AS_NODE: '1' }) },
        windowsHide: true,
        timeout: TIMEOUT_MS,
        maxBuffer: 256 * 1024,
      },
      (error, stdout) => {
        try {
          const value = JSON.parse(stdout);
          if (typeof value.loggedIn !== 'boolean' || (error && value.loggedIn))
            throw error || new Error('Invalid auth status.');
          resolve(value);
        } catch {
          reject(new Error('The CLI sign-in could not be checked.'));
        }
      },
    );
  });
}

function createUsageAdapters({
  env = process.env,
  fetch = globalThis.fetch,
  now = Date.now,
  findAgents = listAgents,
  readStatus = authStatus,
  query = async (request) => (await import('@anthropic-ai/claude-agent-sdk')).query(request),
  connect = (command, signal, options) =>
    new CodexConnection(command, signal, undefined, undefined, options),
} = {}) {
  const claudeHome = () => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const codexHome = () => env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const testOrigin = env.SUPERAPP_USAGE_TEST_ORIGIN;
  // Only the existing loopback fixture mode bypasses the actual installed CLI.
  let fixtures = false;
  try {
    const url = new URL(testOrigin);
    fixtures =
      url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === testOrigin;
  } catch {}

  async function command(provider) {
    const found = (await findAgents()).find((agent) => agent.id === provider)?.executable;
    return found ? cliEntry(found, provider) : null;
  }
  async function fileContext(provider) {
    const home = provider === 'claude' ? claudeHome() : codexHome();
    const file = path.join(home, provider === 'claude' ? '.credentials.json' : 'auth.json');
    const auth = await optionalJSON(file);
    if (
      provider === 'claude' &&
      (env.ANTHROPIC_API_KEY ||
        env.ANTHROPIC_AUTH_TOKEN ||
        env.CLAUDE_CODE_USE_BEDROCK === '1' ||
        env.CLAUDE_CODE_USE_VERTEX === '1' ||
        env.CLAUDE_CODE_USE_FOUNDRY === '1')
    )
      return { accountKey: null, result: unsupported };
    if (provider === 'codex' && (env.OPENAI_API_KEY || auth?.auth_mode === 'apikey'))
      return { accountKey: null, result: unsupported };
    const token =
      provider === 'claude' ? auth?.claudeAiOauth?.accessToken : auth?.tokens?.access_token;
    if (!token)
      return {
        accountKey: null,
        result: {
          status: 'signed-out',
          message:
            provider === 'claude'
              ? 'Sign in to Claude Code to see plan usage.'
              : 'Sign in to Codex with ChatGPT to see plan usage.',
        },
      };
    const identity =
      provider === 'codex' ? auth?.tokens?.account_id : auth?.claudeAiOauth?.accountId;
    const key = token
      ? accountKey(provider, home, identity || null, tokenSubject(token) || token)
      : null;
    const read = () =>
      provider === 'claude'
        ? readClaudeUsage({ configDir: home, fetch, now, testOrigin })
        : readCodexUsage({ codexHome: home, fetch, now, testOrigin });
    const context = { accountKey: key };
    context.read = async () => {
      const result = await read();
      if (JSON.stringify(auth) !== JSON.stringify(await optionalJSON(file))) {
        context.accountKey = null;
        throw new Error('Sign-in changed during usage check.');
      }
      return result;
    };
    return context;
  }
  async function claudeContext() {
    if (fixtures) return fileContext('claude');
    const executable = await command('claude');
    if (!executable) return fileContext('claude');
    const status = await readStatus(executable, env);
    const key = status.loggedIn
      ? accountKey(
          'claude',
          claudeHome(),
          status.authMethod,
          status.apiProvider,
          status.email || null,
          status.orgId || null,
        )
      : null;
    const context = { accountKey: key };
    if (!status.loggedIn)
      return {
        ...context,
        result: { status: 'signed-out', message: 'Sign in to Claude Code to see plan usage.' },
      };
    if (
      (status.apiProvider && status.apiProvider !== 'firstParty') ||
      status.authMethod !== 'claude.ai'
    )
      return { ...context, result: unsupported };
    // With neither email nor organization, don't attribute a restored reading.
    if (!status.email || !status.orgId) context.accountKey = null;
    context.read = async () => {
      const controller = new AbortController();
      let session;
      let result;
      try {
        async function* idleInput() {
          await new Promise(() => {});
        }
        session = await query({
          prompt: idleInput(),
          options: {
            cwd: os.homedir(),
            env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
            tools: [],
            permissionMode: 'dontAsk',
            abortController: controller,
            pathToClaudeCodeExecutable: executable,
            strictMcpConfig: true,
            mcpServers: {},
            settings: { disableAllHooks: true },
          },
        });
        if (typeof session[CLAUDE_USAGE_METHOD] !== 'function')
          throw new Error('Usage method unavailable.');
        const body = await deadline(session[CLAUDE_USAGE_METHOD]({ skipBehaviors: true }), () =>
          controller.abort(),
        );
        if (body?.rate_limits_available === false)
          result = {
            status: 'error',
            message:
              'This Claude sign-in does not expose plan usage. Sign in again with Claude Code.',
          };
        else {
          const parsed = parseClaudeUsage(body?.rate_limits);
          result = hasWindows(parsed)
            ? {
                ...parsed,
                plan: typeof body.subscription_type === 'string' ? body.subscription_type : null,
                status: 'ok',
                source: 'live',
                updatedAt: now(),
              }
            : { status: 'error', message: UNRECOGNISED };
        }
      } catch (error) {
        // Older CLIs may not implement the experimental control method. A
        // file-based OAuth reading remains useful on Windows and Linux.
        const auth = await optionalJSON(path.join(claudeHome(), '.credentials.json'));
        result =
          process.platform !== 'darwin' &&
          !env.CLAUDE_CODE_OAUTH_TOKEN &&
          auth?.claudeAiOauth?.accessToken &&
          /Usage method unavailable|unknown.*request|unsupported|not.*implemented/i.test(
            error.message || '',
          )
            ? await readClaudeUsage({ configDir: claudeHome(), fetch, now })
            : safeError(error);
      } finally {
        session?.close();
      }
      let after;
      try {
        after = await readStatus(executable, env);
      } catch (error) {
        context.accountKey = null;
        throw error;
      }
      if (JSON.stringify(status) !== JSON.stringify(after)) {
        context.accountKey = null;
        throw new Error('Sign-in changed during usage check.');
      }
      return {
        provider: 'claude',
        fiveHour: null,
        weekly: null,
        ...result,
        plan: result.plan || status.subscriptionType || null,
      };
    };
    return context;
  }
  async function codexContext() {
    if (fixtures) return fileContext('codex');
    const executable = await command('codex');
    if (!executable) return fileContext('codex');
    const controller = new AbortController();
    const script = /\.[cm]?js$/i.test(executable);
    const connection = connect(script ? process.execPath : executable, controller.signal, {
      cwd: os.homedir(),
      env: { ...env, ...(script && { ELECTRON_RUN_AS_NODE: '1' }) },
      ...(script && { argsPrefix: [executable] }),
    });
    const context = {
      dispose: () => {
        controller.abort();
        connection.dispose();
      },
    };
    try {
      await deadline(connection.initialize(), () => controller.abort());
      const account = await connection.call('account/read', { refreshToken: false }, TIMEOUT_MS);
      if (!account?.account)
        return {
          ...context,
          result: {
            status: account?.requiresOpenaiAuth === false ? 'unsupported' : 'signed-out',
            message:
              account?.requiresOpenaiAuth === false
                ? unsupported.message
                : 'Sign in to Codex with ChatGPT to see plan usage.',
          },
        };
      if (account.account.type !== 'chatgpt') return { ...context, result: unsupported };
      // Prefer the CLI's active workspace. Older versions without routing
      // metadata may use file identity only if the effective CLI config says
      // file storage; a stale auth.json must not override managed keyring auth.
      let store;
      if (!account.workspaceRouting?.chatgptAccountId) {
        try {
          store = (await connection.call('config/read', { includeLayers: false }, TIMEOUT_MS))
            .config?.cli_auth_credentials_store;
        } catch {
          /* Without a verified store, omit local cache restoration. */
        }
      }
      const auth =
        store === 'file' ? await optionalJSON(path.join(codexHome(), 'auth.json')) : null;
      const workspace = account.workspaceRouting?.chatgptAccountId || auth?.tokens?.account_id;
      const subject = account.account.email || tokenSubject(auth?.tokens?.id_token || '');
      const backend = account.workspaceRouting?.backendOrigin || null;
      context.accountKey =
        workspace && subject ? accountKey('codex', codexHome(), subject, workspace, backend) : null;
      context.read = async () => {
        try {
          const body = await connection.call('account/rateLimits/read', {}, TIMEOUT_MS);
          let after;
          try {
            after = await connection.call('account/read', { refreshToken: false }, TIMEOUT_MS);
          } catch (error) {
            context.accountKey = null;
            throw error;
          }
          if (JSON.stringify(account) !== JSON.stringify(after))
            throw new Error('Sign-in changed during usage check.');
          if (
            auth &&
            JSON.stringify(auth) !==
              JSON.stringify(await optionalJSON(path.join(codexHome(), 'auth.json')))
          )
            throw new Error('Sign-in changed during usage check.');
          if (workspace && body.accountId && workspace !== body.accountId)
            throw new Error('Sign-in changed during usage check.');
          if (body.accountId && subject)
            context.accountKey = accountKey('codex', codexHome(), subject, body.accountId, backend);
          const parsed = parseCodexRateLimits(body, now());
          return {
            provider: 'codex',
            fiveHour: null,
            weekly: null,
            ...parsed,
            plan: parsed.plan || account.account.planType || null,
            ...(hasWindows(parsed)
              ? { status: 'ok', source: 'live', updatedAt: now() }
              : { status: 'error', message: UNRECOGNISED }),
          };
        } catch (error) {
          if (/Sign-in changed/.test(error.message)) {
            context.accountKey = null;
            throw error;
          }
          return {
            provider: 'codex',
            plan: account.account.planType || null,
            fiveHour: null,
            weekly: null,
            ...safeError(error),
          };
        }
      };
      return context;
    } catch (error) {
      context.dispose();
      throw error;
    }
  }
  return {
    contexts: { claude: claudeContext, codex: codexContext },
    readers: { claude: (context) => context.read(), codex: (context) => context.read() },
  };
}

module.exports = { createUsageAdapters, CLAUDE_USAGE_METHOD };
