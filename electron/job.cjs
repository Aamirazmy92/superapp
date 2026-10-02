/*
 * On Windows, terminals inherit this app's Job Object. When that job forbids
 * breakaway (for example when the app was started from an IDE terminal), CLIs
 * cannot start detached background servers such as the Codex daemon.
 *
 * The probe runs through node-pty so it lands in the same job as a terminal;
 * children spawned by Node itself are placed in libuv's own job instead.
 */
const probe = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace SuperappJob -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct StartupInfo {
  public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
  public int dwX; public int dwY; public int dwXSize; public int dwYSize;
  public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
  public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
  public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
}
[StructLayout(LayoutKind.Sequential)]
public struct ProcessInfo { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CreateProcess(string app, System.Text.StringBuilder command, IntPtr processAttributes,
  IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
  ref StartupInfo startup, out ProcessInfo info);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
[DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr process, uint code);
[DllImport("kernel32.dll")] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
'@
$startup = New-Object SuperappJob.Native+StartupInfo
$startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
$info = New-Object SuperappJob.Native+ProcessInfo
$cmd = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
$command = New-Object System.Text.StringBuilder ('"' + $cmd + '" /d /c exit')
# CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW | CREATE_SUSPENDED
$ok = [SuperappJob.Native]::CreateProcess($cmd, $command, [IntPtr]::Zero, [IntPtr]::Zero, $false,
  0x09000004, [IntPtr]::Zero, [NullString]::Value, [ref]$startup, [ref]$info)
if ($ok) {
  # Breaking away from a nested job can leave the child in an outer job.
  $inJob = $true
  [void][SuperappJob.Native]::IsProcessInJob($info.hProcess, [IntPtr]::Zero, [ref]$inJob)
  [void][SuperappJob.Native]::TerminateProcess($info.hProcess, 0)
  [void][SuperappJob.Native]::CloseHandle($info.hThread)
  [void][SuperappJob.Native]::CloseHandle($info.hProcess)
  if ($inJob) { 'SUPERAPP_DETACH=no' } else { 'SUPERAPP_DETACH=yes' }
} else { 'SUPERAPP_DETACH=no' }
`;

let result;
function canDetachProcesses() {
  if (process.platform !== 'win32') return Promise.resolve(true);
  result ||= new Promise((resolve) => {
    let output = '';
    let proc;
    const finish = (value) => {
      clearTimeout(timer);
      try {
        proc?.kill();
      } catch {}
      resolve(value);
    };
    // If the probe cannot run, assume detaching is blocked; --no-daemon still works.
    const timer = setTimeout(() => finish(false), 20000);
    try {
      proc = require('node-pty').spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(probe, 'utf16le').toString('base64'),
        ],
        { name: 'xterm-256color', cols: 200, rows: 24, cwd: process.cwd(), env: process.env },
      );
    } catch {
      finish(false);
      return;
    }
    proc.onData((data) => {
      output += data;
      const match = output.match(/SUPERAPP_DETACH=(yes|no)/);
      if (match) finish(match[1] === 'yes');
    });
    proc.onExit(() => finish(/SUPERAPP_DETACH=yes/.test(output)));
  });
  return result;
}

module.exports = { canDetachProcesses };
