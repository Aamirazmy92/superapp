const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PluginError } = require('./files.cjs');

const TIMEOUT = 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;
const REF = /^(?!-)[A-Za-z0-9._\/-]{1,200}$/;

class GitMissingError extends PluginError {}

function fail(message) {
  throw new PluginError(message);
}

/*
 * Accepts https and ssh remotes only. Rejects options in disguise ("-u…"),
 * transport helpers ("ext::"), local file URLs and embedded credentials.
 */
function validateGitURL(value, { allowFile = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\x00-\x1f"'`]/.test(value) || value.startsWith('-') || value.includes('::'))
    fail('Enter an https:// or ssh Git address.');
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~\/-]+$/.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('Enter an https:// or ssh Git address.');
  }
  if (allowFile && url.protocol === 'file:') return value;
  if (!['https:', 'ssh:'].includes(url.protocol)) fail('Only https:// and ssh Git addresses are supported.');
  if (url.password || (url.protocol === 'https:' && url.username))
    fail('Remove the user name or token from the address. Git uses your saved credentials.');
  return value;
}
function validateRef(ref) {
  if (ref === undefined || ref === null || ref === '') return undefined;
  if (typeof ref !== 'string' || !REF.test(ref) || ref.includes('..')) fail('The Git branch or tag name is invalid.');
  return ref;
}

/** Turns git's stderr into one line a person can act on. */
function describeGitError(stderr, url) {
  const text = String(stderr || '').trim();
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    host = /^git@([^:]+):/.exec(url || '')?.[1] || '';
  }
  if (/Could not resolve host|unable to access.*(Couldn't|Could not) connect|Failed to connect|Network is unreachable|timed out/i.test(text))
    return `Could not reach ${host || 'the Git server'}. Check your connection and try again.`;
  if (/Repository not found|not found|does not appear to be a git repository/i.test(text)) return `The repository ${url} was not found, or you do not have access to it.`;
  if (/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled/i.test(text))
    return `Git needs credentials for ${host || url}. Sign in with git in a terminal first; Veyo never asks for passwords.`;
  if (/Remote branch .* not found|couldn't find remote ref/i.test(text)) return 'That branch, tag or commit was not found in the repository.';
  const last = text.split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
  return last ? `Git failed: ${last.slice(0, 300)}` : 'Git failed without a message.';
}

function createGit({ command = 'git', allowFile = false, timeout = TIMEOUT } = {}) {
  // Settings that keep a repository's own files from running anything here.
  const hardened = (cwd) => [
    '-c', 'core.fsmonitor=',
    '-c', `core.hooksPath=${path.join(cwd || process.cwd(), '.veyo-no-hooks')}`,
    '-c', 'core.symlinks=false',
    '-c', `protocol.file.allow=${allowFile ? 'always' : 'never'}`,
    '-c', 'protocol.ext.allow=never',
    '-c', 'credential.interactive=never',
  ];
  const env = () => ({
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    GIT_LFS_SKIP_SMUDGE: '1',
  });
  function run(args, { cwd, url } = {}) {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...hardened(cwd), ...args],
        { cwd, env: env(), timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout.trim());
          if (error.code === 'ENOENT') return reject(new GitMissingError('Git is not installed or not on PATH. Install Git to add Git marketplaces.'));
          if (error.killed) return reject(new PluginError(`Git did not finish within ${Math.round(timeout / 1000)} seconds.`));
          reject(new PluginError(describeGitError(stderr, url)));
        },
      );
    });
  }
  return {
    allowFile,
    validateURL: (url) => validateGitURL(url, { allowFile }),
    async available() {
      try {
        await run(['--version']);
        return true;
      } catch (error) {
        if (error instanceof GitMissingError) return false;
        throw error;
      }
    },
    /*
     * A shallow clone of one branch, tag or commit, without submodules. Returns
     * the checked-out commit sha. With `sha`, the result must be that commit.
     */
    async clone(url, dir, { ref, sha } = {}) {
      validateGitURL(url, { allowFile });
      const branch = validateRef(ref);
      if (sha !== undefined && sha !== null && !SHA.test(sha)) fail('The pinned commit must be a full 40-character sha.');
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await run(['clone', '--depth', '1', '--no-recurse-submodules', '--single-branch', ...(branch ? ['--branch', branch] : []), '--', url, dir], { cwd: path.dirname(dir), url });
      if (sha) {
        const head = await run(['rev-parse', 'HEAD'], { cwd: dir, url });
        if (head !== sha) {
          await run(['fetch', '--depth', '1', '--no-recurse-submodules', 'origin', sha], { cwd: dir, url });
          await run(['checkout', '--detach', '--quiet', sha], { cwd: dir, url });
        }
      }
      const head = await run(['rev-parse', 'HEAD'], { cwd: dir, url });
      if (sha && head !== sha) fail('The repository did not provide the pinned commit.');
      return head;
    },
  };
}

module.exports = { GitMissingError, createGit, describeGitError, validateGitURL, validateRef };
