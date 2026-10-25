/*
 * On Windows, terminals inherit this app's Job Object. When that job forbids
 * breakaway (for example when the app was started from an IDE terminal), CLIs
 * cannot start detached background servers such as the Codex daemon.
 *
 * The probe runs through node-pty so it lands in the same job as a terminal;
 * children spawned by Node itself are placed in libuv's own job instead.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const probe = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace VeyoJob -Name Native -MemberDefinition @'
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
$startup = New-Object VeyoJob.Native+StartupInfo
$startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
$info = New-Object VeyoJob.Native+ProcessInfo
$cmd = Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
$command = New-Object System.Text.StringBuilder ('"' + $cmd + '" /d /c exit')
# CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW | CREATE_SUSPENDED
$ok = [VeyoJob.Native]::CreateProcess($cmd, $command, [IntPtr]::Zero, [IntPtr]::Zero, $false,
  0x09000004, [IntPtr]::Zero, [NullString]::Value, [ref]$startup, [ref]$info)
if ($ok) {
  # Breaking away from a nested job can leave the child in an outer job.
  $inJob = $true
  [void][VeyoJob.Native]::IsProcessInJob($info.hProcess, [IntPtr]::Zero, [ref]$inJob)
  [void][VeyoJob.Native]::TerminateProcess($info.hProcess, 0)
  [void][VeyoJob.Native]::CloseHandle($info.hThread)
  [void][VeyoJob.Native]::CloseHandle($info.hProcess)
  if ($inJob) { 'VEYO_DETACH=no' } else { 'VEYO_DETACH=yes' }
} else { 'VEYO_DETACH=no' }
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
    // Run from a file: PowerShell with -EncodedCommand stalls process creation for
    // seconds (Windows scans the command line), and the spawn blocks the main thread.
    let folder;
    try {
      folder = fs.mkdtempSync(path.join(os.tmpdir(), 'veyo-probe-'));
      const script = path.join(folder, 'probe.ps1');
      fs.writeFileSync(script, probe);
      proc = require('node-pty').spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { name: 'xterm-256color', cols: 200, rows: 24, cwd: process.cwd(), env: process.env },
      );
    } catch {
      if (folder) fs.rmSync(folder, { recursive: true, force: true });
      finish(false);
      return;
    }
    proc.onExit(() => fs.rm(folder, { recursive: true, force: true }, () => {}));
    proc.onData((data) => {
      output += data;
      const match = output.match(/VEYO_DETACH=(yes|no)/);
      if (match) finish(match[1] === 'yes');
    });
    proc.onExit(() => finish(/VEYO_DETACH=yes/.test(output)));
  });
  return result;
}

module.exports = { canDetachProcesses };
