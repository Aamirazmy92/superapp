const fs = require('node:fs/promises');
const path = require('node:path');
const { inside } = require('../core.cjs');
const { PluginError } = require('./files.cjs');
const { checkArgs, isBatch, relPath } = require('./manifest.cjs');

const ROOT_PREFIX = '${pluginRoot}/';
// What Veyo can start directly or through PowerShell/cmd on Windows.
const WINDOWS_RUNNABLE = /\.(exe|cmd|bat|ps1)$/i;

function fail(message) {
  throw new PluginError(message);
}
function substitute(value, roots) {
  return value.replaceAll('${pluginRoot}', roots.pluginRoot).replaceAll('${projectRoot}', roots.projectRoot);
}

/*
 * Turns a plugin command or agent preset into an executable and an argument
 * array for a terminal. Nothing here goes through a shell string: PATH names are
 * resolved to files, plugin files must still be inside the plugin, and the
 * arguments are checked again after the folders are substituted in.
 */
async function buildLaunch({ program, args = [] }, { pluginRoot, projectRoot, resolveProgram, platform = process.platform }) {
  let executable;
  if (program.startsWith(ROOT_PREFIX)) {
    const rel = relPath(program.slice(ROOT_PREFIX.length), 'program');
    const root = await fs.realpath(pluginRoot);
    const target = path.join(root, ...rel.split('/'));
    let real;
    try {
      if ((await fs.lstat(target)).isSymbolicLink()) throw new Error();
      real = await fs.realpath(target);
    } catch {
      fail(`The plugin file "${rel}" is missing. Reinstall the plugin.`);
    }
    if (!inside(root, real)) fail(`The plugin file "${rel}" is outside the plugin folder.`);
    if (platform === 'win32' && !WINDOWS_RUNNABLE.test(real))
      fail(`"${rel}" cannot be run directly on Windows. Use an .exe, .cmd, .bat or .ps1 file, or run it with a program such as node.`);
    executable = real;
  } else {
    executable = await resolveProgram(program);
    if (!executable) fail(`"${program}" was not found on PATH. Install it, then try again.`);
  }
  const roots = { pluginRoot: await fs.realpath(pluginRoot), projectRoot };
  // Approval flags were refused when the plugin loaded; folder names can't add flags.
  const finalArgs = checkArgs(args.map((arg) => substitute(arg, roots)), { batch: isBatch(executable) });
  return { executable, args: finalArgs };
}

module.exports = { buildLaunch };
