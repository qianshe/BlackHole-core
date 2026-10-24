// Policy guards, not an Inno compiler or installer acceptance substitute.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const root=fileURLToPath(new URL('..',import.meta.url));
const source=fs.readFileSync(path.join(root,'installers/windows/desktop.iss'),'utf8');
const script=source.split('\n').filter(line=>!line.trimStart().startsWith(';')).join('\n');
test('Inno policy is per-user, stable identity and does not implicitly terminate applications',()=>{
 assert.match(script,/PrivilegesRequired=lowest/);assert.match(script,/DefaultDirName=\{localappdata\}/);assert.match(script,/DisableDirPage=auto/);assert.match(script,/UsePreviousAppDir=yes/);assert.match(script,/AppMutex=Local/);assert.match(script,/"StellarBridge\.BlackHole\.Desktop"/);assert.match(script,/"StellarBridge\.BlackHole\.Desktop\.Test"/);assert.match(script,/AppId=\{#ProductId\}/);assert.match(script,/CloseApplications=no/);assert.match(script,/RestartApplications=no/);
});

test('manual installation refuses downgrade and checks older window before replacing files',()=>{
 assert.match(script,/function InitializeSetup\(\): Boolean/);
 assert.match(script,/RegQueryStringValue\(HKCU,/);
 assert.match(script,/StrToVersion\(OldVersion, OldPacked\)/);
 assert.match(script,/ComparePackedVersion\(OldPacked, NewPacked\) > 0/);
 assert.match(script,/FindWindowByWindowName\('BlackHole · 17306'\)/);
 assert.match(script,/FindWindowByWindowName\('BlackHole · 7306'\)/);
 assert.match(script,/AppMutex=Local\\BlackHoleDesktopTestInstall,Local\\BlackHoleTray-7306,Local\\BlackHoleTray-17306/);
 assert.match(script,/AppMutex=Local\\BlackHoleDesktopInstall,Local\\BlackHoleTray-7306/);
});
test('Inno tracks only shell payload and never includes Core/data deletion or daemon Stop',()=>{
 assert.doesNotMatch(script,/\[(UninstallDelete|Registry)\]/i);assert.doesNotMatch(script,/--stop|taskkill|\/api\/shutdown/i);
 const files=script.match(/^Source:.*$/gm)??[];assert.equal(files.length,9);
 assert.equal(files.filter(file=>/bootstrap\\node[.]exe/.test(file)).length,1);
 assert.equal(files.filter(file=>/bootstrap\\node-LICENSE/.test(file)).length,1);
 const helper=files.filter(file=>/installer-preflight-cli\.cjs/.test(file));assert.equal(helper.length,1);assert.match(helper[0],/Flags: dontcopy/);
 for(const file of files.filter(file=>!helper.includes(file))){assert.match(file,/DestDir: "\{app\}/);assert.doesNotMatch(file,/\*|\.blackhole|\\versions\\|\\state\\/i)}
 assert.match(script,/function PrepareToInstall\(var NeedsRestart: Boolean\): String/);
 assert.match(script,/ExtractTemporaryFile\('installer-preflight-cli.cjs'\)/);
 assert.match(script,/41: Result :=/);
 assert.match(script,/--apply-bundled-core --print/);assert.doesNotMatch(script,/--provision-only --print/);assert.match(script,/CompareText\(Current, Expected\) = 0/);
});
test('Desktop EXE must embed the shared BlackHole icon at all Windows taskbar sizes',()=>{
 const packager=fs.readFileSync(path.join(root,'scripts/package-desktop.mjs'),'utf8');
 const native=fs.readFileSync(path.join(root,'packages/desktop-launcher/cmd/blackhole/window_windows.go'),'utf8');
 assert.match(packager,/RT_GROUP_ICON/,'the EXE must contain a Windows icon group');
 assert.match(packager,/16,24,32,48,64,128,256/,'multiple Windows scaling sizes are required');
 assert.match(packager,/desktop_icon_group_missing|desktop_icon_entries_missing/,'read-back is mandatory');
 assert.match(packager,/go-winres\.exe/,'icon resources must be inserted into the fresh executable');
 assert.match(native,/procLoadImageW/,'WebView2 window uses the same icon group as the taskbar');
});
test('production Desktop packaging rejects test key IDs before reading fixtures or creating output',{skip:process.platform!=='win32'||process.arch!=='x64'},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bh-desktop-package-policy-'));
 try{const output=path.join(dir,'output');const result=spawnSync(process.execPath,[path.join(root,'scripts/package-desktop.mjs'),'--seed',path.join(dir,'missing.zip'),'--public-key',path.join(dir,'missing.pem'),'--key-id','TEST-local','--manager',path.join(dir,'missing.mjs'),'--output',output,'--environment','production','--node-exe',path.join(dir,'node.exe'),'--node-sha256','0'.repeat(64),'--node-license',path.join(dir,'LICENSE'),'--node-license-sha256','0'.repeat(64)],{encoding:'utf8',windowsHide:true});assert.notEqual(result.status,0);assert.match(result.stderr,/production_test_key_rejected/);assert.equal(fs.existsSync(output),false);}finally{fs.rmSync(dir,{recursive:true,force:true})}
});
