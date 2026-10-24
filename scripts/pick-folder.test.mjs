// Real Windows picker host contract without opening a dialog or touching user files.
// Ensures console remains invisible and the PowerShell STA creates COM dialogs
// under a per-monitor-v2 DPI context (not Windows bitmap upscaling).
import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'src/util/pick-folder.ts'), 'utf8');
const native = /const WIN_SOURCE = String\.raw`([\s\S]*?)`;/u.exec(source)?.[1];
const exec = promisify(execFile);

test('Windows folder selection never creates a visible PowerShell console', () => {
  assert.ok(native, 'Windows COM source remains available');
  assert.match(source, /execFile\(cmd, args, \{ timeout: TIMEOUT_MS, windowsHide: true, shell: false,/);
  assert.match(source, /'-STA', '-WindowStyle', 'Hidden'/);
  assert.match(source, /\[BhFolderPick\]::EnableHighDpi\(\)/);
  assert.ok(source.indexOf('[BhFolderPick]::EnableHighDpi()') < source.indexOf("'Add-Type -AssemblyName System.Windows.Forms'"),
    'DPI context must be set before WinForms loads or creates the owner window');
  assert.ok(source.indexOf('Add-Type -AssemblyName System.Windows.Forms') < source.indexOf('$f = New-Object System.Windows.Forms.Form'),
    'hidden owner window is created after DPI initialization');
  assert.match(source, /finally \{ \$f\.Close\(\); \$f\.Dispose\(\) \}/,
    'hidden owner window is released on success, cancellation and error');
});

test('isolated PowerShell picker host has a hidden console and per-monitor-v2 DPI', { timeout: 40_000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Windows native DPI API only'); return; }
  assert.ok(native);
  const probe = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(native, 'utf8').toString('base64')}')))
[BhFolderPick]::EnableHighDpi()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BhDpiPickerProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] public static extern bool AreDpiAwarenessContextsEqual(IntPtr x, IntPtr y);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  public static bool PerMonitorV2() { return AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4)); }
  public static bool ConsoleVisible() { IntPtr handle = GetConsoleWindow(); return handle != IntPtr.Zero && IsWindowVisible(handle); }
}
'@
Write-Output ('DPI_V2=' + [BhDpiPickerProbe]::PerMonitorV2().ToString())
Write-Output ('CONSOLE_VISIBLE=' + [BhDpiPickerProbe]::ConsoleVisible().ToString())
`;
  const encoded = Buffer.from(probe, 'utf16le').toString('base64');
  const { stdout } = await exec('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], { windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 8192 });
  assert.match(stdout, /DPI_V2=True/i, 'the native file dialog must be per-monitor-v2 aware');
  assert.match(stdout, /CONSOLE_VISIBLE=False/i, 'folder picker must not surface a PowerShell console');
});
