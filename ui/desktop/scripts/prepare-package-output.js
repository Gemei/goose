const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const desktopRoot = path.resolve(__dirname, '..');
const outRoot = path.join(desktopRoot, 'out');
const winPackageDir = path.join(outRoot, 'Goose-win32-x64');
const winAsar = path.join(winPackageDir, 'resources', 'app.asar');

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stopGooseLockers() {
  if (process.platform !== 'win32') {
    return;
  }

  try {
    execFileSync('taskkill', ['/F', '/IM', 'Goose.exe', '/T'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    // Goose was not running
  }
}

function describeLockers(targetPath) {
  if (process.platform !== 'win32') {
    return '';
  }

  const ps = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
public class FileLock {
  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public uint ApplicationType; public uint AppStatus; public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, [In] RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);
  public static void Print(string path) {
    uint handle; if (RmStartSession(out handle, 0, Guid.NewGuid().ToString()) != 0) return;
    try {
      string[] resources = new string[] { path };
      if (RmRegisterResources(handle, 1, resources, 0, null, 0, null) != 0) return;
      uint needed = 0, count = 0, reboot = 0;
      int res = RmGetList(handle, out needed, ref count, null, ref reboot);
      if (res != 234) return;
      count = needed; RM_PROCESS_INFO[] arr = new RM_PROCESS_INFO[count];
      if (RmGetList(handle, out needed, ref count, arr, ref reboot) != 0) return;
      for (int i = 0; i < count; i++) {
        int pid = arr[i].Process.dwProcessId;
        string pname = "";
        try { pname = Process.GetProcessById(pid).ProcessName; } catch {}
        Console.WriteLine(pname + " (pid " + pid + ")");
      }
    } finally { RmEndSession(handle); }
  }
}
'@
[FileLock]::Print('${targetPath.replace(/\\/g, '\\\\').replace(/'/g, "''")}')
`;

  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }
    ).trim();
    return out;
  } catch {
    return '';
  }
}

function removeWithRetries(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  const maxAttempts = 8;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.rmSync(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 150,
      });
      return;
    } catch (error) {
      lastError = error;
      if (error && (error.code === 'EBUSY' || error.code === 'EPERM')) {
        sleep(200 * attempt);
        continue;
      }
      throw error;
    }
  }

  const lockers = describeLockers(targetPath);
  const lockerLine = lockers
    ? `\nKeeping the file open: ${lockers.replace(/\r?\n/g, ', ')}`
    : '';
  throw new Error(
    `Could not remove locked package output:\n  ${targetPath}\n` +
      `${lastError}${lockerLine}\n` +
      'Close that app (VS Code: close any tab or preview of app.asar), quit Goose from the tray, then retry.'
  );
}

function writeOutDir(dir) {
  fs.writeFileSync(path.join(desktopRoot, '.forge-out-dir'), dir, 'utf8');
}

function canRemove(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return true;
  }
  try {
    fs.rmSync(targetPath, {
      recursive: true,
      force: true,
      maxRetries: 2,
      retryDelay: 100,
    });
    return true;
  } catch {
    return false;
  }
}

stopGooseLockers();

const candidates = ['out', 'out-build', 'out-pkg'];
let chosen;
for (const dir of candidates) {
  const packageDir = path.join(desktopRoot, dir, 'Goose-win32-x64');
  const asarPath = path.join(packageDir, 'resources', 'app.asar');
  if (canRemove(asarPath) && canRemove(packageDir)) {
    chosen = dir;
    break;
  }
}
if (!chosen) {
  chosen = `out-run-${Date.now()}`;
}
writeOutDir(chosen);
console.log(`Packaging to ${chosen}/Goose-win32-x64`);
