import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const source = fs.readFileSync(new URL('../src/vscodeRipgrep.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const mod = { exports: {} }; vm.runInNewContext(js, { module: mod, exports: mod.exports, require, process, console });
const { pathFromEnvironment, rgOnPath, bundledVsCodeRg, resolveExecutionRg, prependToolDirectory } = mod.exports;
const existing = (...files) => { const set = new Set(files); return file => set.has(file); };

test('an rg already on PATH wins and is not replaced by VS Code internals', () => {
  const host = { platform: 'win32', arch: 'x64', appRoot: 'C:\\Code\\resources\\app', pathValue: 'C:\\Tools;C:\\Windows' };
  const user = 'C:\\Tools\\rg.exe', bundled = 'C:\\Code\\resources\\app\\node_modules.asar.unpacked\\@vscode\\ripgrep-universal\\bin\\win32-x64\\rg.exe';
  assert.equal(resolveExecutionRg(host, existing(user, bundled)), user);
  assert.equal(prependToolDirectory(host.pathValue, user, 'win32'), host.pathValue);
});

test('current VS Code ripgrep-universal layout is discovered per platform and architecture', () => {
  const cases = [
    ['win32', 'x64', 'C:\\Code\\app', 'C:\\Code\\app\\node_modules.asar.unpacked\\@vscode\\ripgrep-universal\\bin\\win32-x64\\rg.exe'],
    ['darwin', 'arm64', '/Applications/Code.app/Contents/Resources/app', '/Applications/Code.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-arm64/rg'],
    ['linux', 'x64', '/usr/share/code/resources/app', '/usr/share/code/resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/linux-x64/rg'],
  ];
  for (const [platform, arch, appRoot, expected] of cases) {
    assert.equal(bundledVsCodeRg({ platform, arch, appRoot, pathValue: '' }, existing(expected)), expected);
  }
});

test('legacy VS Code layouts remain best-effort fallbacks and missing binaries stay optional', () => {
  const host = { platform: 'linux', arch: 'arm64', appRoot: '/opt/code/resources/app', pathValue: '/usr/bin' };
  const legacy = '/opt/code/resources/app/node_modules/@vscode/ripgrep/bin/rg';
  assert.equal(bundledVsCodeRg(host, existing(legacy)), legacy);
  assert.equal(resolveExecutionRg(host, existing()), undefined);
  assert.equal(bundledVsCodeRg({ ...host, appRoot: '' }, existing(legacy)), undefined);
});

test('PATH injection is scoped, prepends once, and respects platform case semantics', () => {
  assert.equal(prependToolDirectory('C:\\Windows;C:\\Tools', 'D:\\VSCode\\rg.exe', 'win32'), 'D:\\VSCode;C:\\Windows;C:\\Tools');
  assert.equal(prependToolDirectory('d:\\vscode;C:\\Windows', 'D:\\VSCode\\rg.exe', 'win32'), 'd:\\vscode;C:\\Windows');
  assert.equal(prependToolDirectory('/usr/bin:/bin', '/opt/code/rg', 'linux'), '/opt/code:/usr/bin:/bin');
  assert.equal(prependToolDirectory('/opt/code:/usr/bin', '/opt/code/rg', 'linux'), '/opt/code:/usr/bin');
});

test('quoted PATH entries are recognized without spawning a shell', () => {
  const host = { platform: 'win32', arch: 'x64', appRoot: '', pathValue: '"C:\\Program Files\\rg";C:\\Windows' };
  assert.equal(rgOnPath(host, existing('C:\\Program Files\\rg\\rg.exe')), 'C:\\Program Files\\rg\\rg.exe');
});


test('plain spawned-environment objects resolve Windows Path case-insensitively', () => {
  assert.equal(pathFromEnvironment({ Path: 'C:\\Tools' }), 'C:\\Tools');
  assert.equal(pathFromEnvironment({ PATH: 'D:\\Preferred', Path: 'C:\\Tools' }), 'D:\\Preferred');
});
test('daemon startup passes the absolute rg separately on Windows and fingerprints it', () => {
  const daemon = fs.readFileSync(new URL('../src/daemonManager.ts', import.meta.url), 'utf8');
  assert.match(daemon, /resolveExecutionRg\(\{ platform: process\.platform, arch: process\.arch, appRoot: vscodeEnv\.appRoot/);
  assert.match(daemon, /env\.BLACKHOLE_RG = rg/);
  assert.match(daemon, /process\.platform !== 'win32'.*prependToolDirectory/);
  assert.match(daemon, /fingerprint\(\{ config: c, entry, terminalShell, executionRg: rg \}\)/);
  assert.match(daemon, /executionRg: snapshot \? snapshot\.executionRg : resolveExecutionRg/);
  assert.doesNotMatch(daemon, /environmentVariableCollection|openai\.chatgpt|copilot.*rg/i);
});

test('daemon follows the configured VS Code default terminal profile before the OS shell fallback', () => {
  const daemon = fs.readFileSync(new URL('../src/daemonManager.ts', import.meta.url), 'utf8');
  const extension = fs.readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.match(daemon, /defaultProfile\.\$\{key\}/);assert.match(daemon, /profiles\.\$\{key\}/);
  assert.match(daemon, /profile\?\.source === 'PowerShell'.*'pwsh\.exe'/s);assert.match(daemon, /return vscodeEnv\.shell \|\| undefined/);
  assert.match(daemon, /env\.BLACKHOLE_PROCESS_SHELL = terminalShell/);assert.match(daemon, /terminalShell: snapshot \? snapshot\.terminalShell : defaultTerminalShell\(\)/);
  assert.match(extension, /terminal\.integrated\.defaultProfile/);assert.match(extension, /terminal\.integrated\.profiles/);
});
