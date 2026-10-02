const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const core = require('./core.cjs');
const run = promisify(execFile);
async function git(root, args) {
  return (
    // Repositories can configure fsmonitor as an executable. Source-control
    // refreshes happen automatically, so never run that repository command.
    await run('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' },
    })
  ).stdout;
}
async function status(root) {
  try {
    const [branch, porcelain] = await Promise.all([
      git(root, ['branch', '--show-current']),
      git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ]);
    const entries = porcelain.split('\0'),
      files = [];
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i]) continue;
      const entry = { status: entries[i].slice(0, 2), path: entries[i].slice(3) };
      if (/[RC]/.test(entry.status)) entry.originalPath = entries[++i];
      files.push(entry);
    }
    return { available: true, branch: branch.trim() || 'Detached HEAD', files };
  } catch (error) {
    return {
      available: false,
      branch: '',
      files: [],
      error:
        error.code === 'ENOENT'
          ? 'Git is not installed or is unavailable on PATH.'
          : 'This folder is not an accessible Git repository.',
    };
  }
}
async function change(root, relative) {
  core.validateRelative(relative);
  const found = (await status(root)).files.find((entry) => entry.path === relative);
  if (!found) throw new Error('This change is no longer present. Refresh source control.');
  return found;
}
async function diff(root, relative, staged = false) {
  const entry = await change(root, relative);
  if (entry.status === '??')
    return `Untracked file: ${relative}\n\n${(await core.readFile(root, relative)).content}`;
  return git(root, [
    'diff',
    ...(staged ? ['--cached'] : []),
    '--no-ext-diff',
    '--no-textconv',
    '--',
    relative,
    ...(entry.originalPath ? [entry.originalPath] : []),
  ]);
}
async function stage(root, relative) {
  const entry = await change(root, relative);
  return git(root, ['add', '--', relative, ...(entry.originalPath ? [entry.originalPath] : [])]);
}
async function unstage(root, relative) {
  const entry = await change(root, relative);
  let head = true;
  try {
    await git(root, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    head = false;
  }
  return git(root, [
    ...(head ? ['reset', 'HEAD'] : ['rm', '--cached']),
    '--',
    relative,
    ...(entry.originalPath ? [entry.originalPath] : []),
  ]);
}
async function commit(root, message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 10000)
    throw new Error('Enter a commit message.');
  const current = await status(root);
  if (!current.files.some((entry) => ![' ', '?', '!'].includes(entry.status[0])))
    throw new Error('Stage changes before committing.');
  return git(root, ['commit', '-m', message.trim()]);
}
module.exports = { status, diff, stage, unstage, commit };
