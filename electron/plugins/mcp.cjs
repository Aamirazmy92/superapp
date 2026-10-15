const { PluginError } = require('./files.cjs');

const CLIS = { claude: 'Claude Code', codex: 'Codex' };
const CLIENT_ID = /^[A-Za-z0-9._-]{1,200}$/;
const BEARER_ENV = /^Bearer \$\{([A-Z_][A-Z0-9_]{0,63})\}$/;

function fail(message) {
  throw new PluginError(message);
}

/** The name a server gets in the coding CLI: the plugin's own name when they match. */
function serverName(plugin, server) {
  const name = server.name === plugin ? plugin : `${plugin}-${server.name}`;
  return name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}
const claudeScope = (scope) => (scope === 'project' ? 'local' : 'user');

/** Whether a CLI can add this server at all, and why not. */
function cliSupport(cli, server) {
  if (cli === 'claude') return null;
  if (server.type === 'sse') return 'Codex does not support SSE MCP servers.';
  if (server.auth?.type === 'oauth-client')
    return 'Codex needs the OAuth client secret on its command line. Add this server in Claude Code, or add it to Codex by hand.';
  const headers = Object.entries(server.headers || {});
  if (headers.some(([key, value]) => key.toLowerCase() !== 'authorization' || !BEARER_ENV.test(value)))
    return 'Codex cannot set these headers from its command line. Add this server to Codex by hand.';
  return null;
}

/*
 * The arguments for the coding CLI's own "mcp add" command, and what to do
 * after it. Veyo never edits another tool's configuration files and never
 * handles secrets: tokens stay in environment variables the CLI reads, and the
 * CLI itself prompts for an OAuth client secret in the visible terminal.
 */
function mcpAddArgs(cli, { server, plugin, scope, installPath }, { clientId } = {}) {
  if (!Object.hasOwn(CLIS, cli)) fail('Choose Claude Code or Codex.');
  const unsupported = cliSupport(cli, server);
  if (unsupported) fail(unsupported);
  const root = (value) => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', installPath).replaceAll('${pluginRoot}', installPath);
  const name = serverName(plugin, server);
  const env = Object.entries(server.env || {});
  const headers = Object.entries(server.headers || {});
  const auth = server.auth || null;
  if (auth?.type === 'oauth-client' && (typeof clientId !== 'string' || !CLIENT_ID.test(clientId.trim())))
    fail('Enter the OAuth client ID from your provider (letters, digits, dots, hyphens and underscores).');
  const followUp =
    auth?.type === 'oauth' || auth?.type === 'oauth-client'
      ? { kind: 'login', args: ['mcp', 'login', name] }
      : auth?.type === 'env'
        ? { kind: 'env', variable: auth.variable, url: auth.url, label: auth.label }
        : null;
  if (cli === 'claude') {
    const scopeName = claudeScope(scope);
    // -e and -H take several values, so they follow the name.
    const args =
      server.type === 'stdio'
        ? ['mcp', 'add', '--scope', scopeName, name, ...env.flatMap(([key, value]) => ['-e', `${key}=${root(value)}`]), '--', root(server.command), ...server.args.map(root)]
        : [
            'mcp', 'add', '--transport', server.type, '--scope', scopeName,
            ...(auth?.type === 'oauth-client' ? ['--client-id', clientId.trim(), '--client-secret', '--callback-port', String(auth.callbackPort)] : []),
            name, server.url,
            ...headers.flatMap(([key, value]) => ['-H', `${key}: ${value}`]),
          ];
    return {
      name,
      args,
      followUp,
      note:
        (scopeName === 'user'
          ? 'Adds the server to Claude Code for all your projects (user scope).'
          : 'Adds the server to Claude Code for this project only (local scope, stored in your Claude settings, not in the repository).') +
        (auth?.type === 'oauth-client' ? ' Claude Code asks for the client secret in the terminal; Veyo never sees it.' : ''),
    };
  }
  const bearer = headers.map(([, value]) => BEARER_ENV.exec(value)[1]);
  const args =
    server.type === 'stdio'
      ? ['mcp', 'add', name, ...env.flatMap(([key, value]) => ['--env', `${key}=${root(value)}`]), '--', root(server.command), ...server.args.map(root)]
      : ['mcp', 'add', name, '--url', server.url, ...bearer.flatMap((variable) => ['--bearer-token-env-var', variable])];
  return {
    name,
    args,
    // Codex signs in to OAuth servers as part of adding them (verified 2026-10-08).
    followUp: auth?.type === 'oauth' ? null : followUp,
    note:
      'Adds the server to Codex for all your projects. Codex has no per-project MCP setting.' +
      (auth?.type === 'oauth' ? ' Codex then opens your browser to sign in.' : ''),
  };
}

/** Removes a server Veyo added earlier. */
function mcpRemoveArgs(cli, name, scope) {
  if (!Object.hasOwn(CLIS, cli)) fail('Choose Claude Code or Codex.');
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) fail('Unknown MCP server.');
  return cli === 'claude' ? ['mcp', 'remove', name, '-s', claudeScope(scope)] : ['mcp', 'remove', name];
}

module.exports = { CLIS, cliSupport, mcpAddArgs, mcpRemoveArgs, serverName };
