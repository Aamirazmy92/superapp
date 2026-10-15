/*
 * How a terminal starts a program with arguments, without building a shell
 * string from the arguments' content:
 * - an .exe (or any program off Windows) is spawned directly with the array;
 * - a .cmd/.bat goes through cmd.exe, which cannot quote % ! ^ & | < > or ",
 *   so callers refuse those first (see plugins/manifest.cjs checkArgs);
 * - anything else on Windows (a .ps1 or extensionless shim) goes through
 *   PowerShell with every part single-quoted.
 */
// PowerShell treats the typographic single quotes as quote characters too.
const quotePowerShell = (part) => `'${part.replace(/['‘’‚‛]/g, '$&$&')}'`;

function programCommand(executable, args, { platform = process.platform, comSpec, powershell }) {
  if (platform !== 'win32' || /\.exe$/i.test(executable)) return { command: executable, args };
  if (/\.(cmd|bat)$/i.test(executable))
    return {
      command: comSpec || 'cmd.exe',
      // A string is passed to ConPTY verbatim; node-pty would escape the quotes in an array.
      args: `/d /s /c "${[executable, ...args].map((part) => `"${part}"`).join(' ')}"`,
    };
  return {
    command: powershell,
    args: ['-NoLogo', '-NoProfile', '-Command', ['&', ...[executable, ...args].map(quotePowerShell)].join(' ')],
  };
}

module.exports = { programCommand, quotePowerShell };
