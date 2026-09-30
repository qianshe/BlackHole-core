// Native "choose folder" dialog on the computer running the daemon (Local Web "添加项目").
// Windows: the Explorer-style IFileOpenDialog in folder mode; macOS: `choose folder`;
// Linux: zenity, then kdialog. The chosen path comes back as base64 UTF-8, so no console
// code page is involved.
import { execFile } from 'node:child_process';

export type PickResult = { path: string } | { cancelled: true } | { unavailable: true };

const TIMEOUT_MS = 10 * 60_000; // a dialog nobody answers must not hold the request forever
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

const WIN_SOURCE = String.raw`
using System; using System.Runtime.InteropServices;
public static class BhFolderPick {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr owner); void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex();
    void Advise(); void Unadvise(); void SetOptions(uint fos); void GetOptions(out uint fos);
    void SetDefaultFolder(); void SetFolder(); void GetFolder(); void GetCurrentSelection();
    void SetFileName(); void GetFileName(); void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel(); void SetFileNameLabel(); void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem { void BindToHandler(); void GetParent(); void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name); }
  public static string Pick(IntPtr owner, string title) {
    var d = (IFileDialog)new FileOpenDialog();
    uint o; d.GetOptions(out o); d.SetOptions(o | 0x20 | 0x40 | 0x800); // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST
    d.SetTitle(title);
    if (d.Show(owner) != 0) return null;
    IShellItem item; d.GetResult(out item);
    string p; item.GetDisplayName(0x80058000, out p); // SIGDN_FILESYSPATH
    return p;
  }
}`;

function winScript(title: string): string {
  // A hidden topmost owner window brings the dialog in front of the browser.
  return [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms',
    `Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(WIN_SOURCE)}')))`,
    '$f = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; Width = 1; Height = 1; StartPosition = "CenterScreen" }',
    '$f.Show(); $f.Activate()',
    `$p = [BhFolderPick]::Pick($f.Handle, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(title)}')))`,
    '$f.Close()',
    'if ($p) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p)) } else { "CANCEL" }',
  ].join('\n');
}

function run(cmd: string, args: string[]): Promise<{ code: number | null; out: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: false, maxBuffer: 1 << 20 }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out: String(stdout ?? '').trim(), missing: e?.code === 'ENOENT' });
    });
  });
}

const fromB64 = (s: string): string => Buffer.from(s, 'base64').toString('utf8');

export async function pickFolder(title = '选择项目文件夹', platform: NodeJS.Platform = process.platform): Promise<PickResult> {
  if (platform === 'win32') {
    const script = Buffer.from(winScript(title), 'utf16le').toString('base64');
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', script]);
    if (r.missing) return { unavailable: true };
    const line = r.out.split(/\r?\n/).pop() ?? '';
    if (r.code !== 0 || !line) return { unavailable: true };
    return line === 'CANCEL' ? { cancelled: true } : { path: fromB64(line) };
  }
  if (platform === 'darwin') {
    const r = await run('osascript', ['-e', `set p to POSIX path of (choose folder with prompt ${JSON.stringify(title)})`, '-e', 'do shell script "printf %s " & quoted form of p & " | base64"']);
    if (r.missing) return { unavailable: true };
    if (r.code !== 0) return { cancelled: true }; // error -128: user cancelled
    return r.out ? { path: fromB64(r.out).replace(/(.)\/$/, '$1') } : { cancelled: true };
  }
  const tools: [string, string[]][] = [['zenity', ['--file-selection', '--directory', `--title=${title}`]], ['kdialog', ['--getexistingdirectory', '.', '--title', title]]];
  for (const [cmd, args] of tools) {
    const r = await run(cmd, args);
    if (r.missing) continue;
    if (r.code !== 0) return { cancelled: true };
    return r.out ? { path: r.out } : { cancelled: true };
  }
  return { unavailable: true };
}
