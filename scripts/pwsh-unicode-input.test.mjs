import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {encodeCodePage, encodeShellInput, streamDecoder, UTF8} from '../dist/workspace/shell-codepage.js';
import {PersistentShell, powerShellEnvironment} from '../dist/workspace/pwsh.js';

const win=process.platform==='win32';
const root=fileURLToPath(new URL('../',import.meta.url));
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const value='\u5b66\u4e60\u{1f600}\u221e $literal ` "quotes"';
const bins=win?[path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),'pwsh.exe']:[];
const decode=(cp,b)=>streamDecoder(cp)(b);

// Independent expectations: original Unicode code units, not a second call to our encoder.
test('command input never uses the lossy code-page probe encoder directly',{skip:!win},()=>{
 for(const cp of [1252,936,UTF8]){
  const text=`$bhValue=${quote(value)}\n`;
  const raw=encodeCodePage(cp,text),safe=encodeShellInput(cp,text);
  if(cp!==UTF8){
   assert.notEqual(decode(cp,raw),text,'regression setup must expose replacement/best-fit loss');
   assert.match(safe.toString('ascii'),/^Microsoft\.PowerShell\.Utility\\Invoke-Expression -Command /);
   assert.ok([...safe].every(b=>b<128),'lossless fallback must be ASCII-only');
  }else assert.equal(decode(cp,safe),text);
 }
 const ascii="Write-Output 'plain'; $x=2\n";
 assert.equal(decode(1252,encodeShellInput(1252,ascii)),ascii,'unchanged inputs keep their original transport');
});

for(const bin of bins)for(const constrained of [false,true]){
 test(`${path.basename(bin)}: CP1252/936/UTF8 payloads preserve Unicode, scope and policy (${constrained?'constrained':'normal'})`,{timeout:60000},()=>{
  for(const cp of [1252,936,UTF8]){
   const script=`$bhValue=${quote(value)}; $bhTransportMode=$ExecutionContext.SessionState.LanguageMode; function Get-BhValue { $bhValue }; Write-Output 'ready'`;
   // Decode the emulated stdin code page before passing it to this real shell.
   const wire=encodeShellInput(cp,script+'\n');
   const input="$ProgressPreference='SilentlyContinue'\n"+(constrained?"$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'\n":'')
    +decode(cp,wire)+"Write-Output ((Get-BhValue).ToCharArray() | ForEach-Object { [int]$_ })\n"
    +"Write-Output $bhTransportMode\n";
   // The emulated transport was decoded above. Marshal that Unicode text via
   // PowerShell's UTF-16LE argument, not a second UTF-8 write to this host's ACP stdin.
   const r=spawnSync(bin,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(input,'utf16le').toString('base64')],{
    cwd:root,encoding:'utf8',env:powerShellEnvironment(),windowsHide:true,timeout:15000});
   assert.equal(r.status,0,r.error?.message??r.stderr);assert.equal(r.stderr,'');
   const lines=r.stdout.trim().split(/\r?\n/);assert.equal(lines.shift(),'ready');
   assert.equal(lines.pop(),constrained?'ConstrainedLanguage':'FullLanguage');
   assert.equal(String.fromCharCode(...lines.map(Number)),value,`cp ${cp}`);
  }
 });

 test(`${path.basename(bin)}: persistent Unicode cwd, variables, exit and recovery (${constrained?'constrained':'normal'})`,{timeout:60000},async t=>{
  const cache=path.join(root,'.cache');fs.mkdirSync(cache,{recursive:true});
  const dir=fs.mkdtempSync(path.join(cache,'pwsh-unicode-'));
  const target=path.join(dir,'\u5b66\u4e60\u{1f600}');fs.mkdirSync(target);
  const children=[];
  const shell=new PersistentShell({cwd:dir,bin,timeoutMs:10000,detectCodePage:true,backend:cwd=>{
   const child=spawn(bin,['-NoLogo','-NoProfile','-NonInteractive','-Command','-'],{
    cwd,env:powerShellEnvironment(),windowsHide:true,stdio:['pipe','pipe','pipe']});
   children.push(child);
   if(constrained)child.stdin.write("$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'\n");
   return {
    write:line=>child.stdin.write(line),onStdout:cb=>child.stdout.on('data',cb),onStderr:cb=>child.stderr.on('data',cb),
    onExit:cb=>{child.on('exit',cb);child.on('error',()=>cb(null));},kill:()=>child.kill(),
   };
  }});
  t.after(async()=>{
   shell.dispose();
   for(const child of children)if(child.exitCode===null&&child.signalCode===null){
    await new Promise(resolve=>{child.once('exit',resolve);child.kill();});
   }
   fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const first=await shell.run(`$bhValue=${quote(value)}; function Get-BhValue { $bhValue }; Set-Location -LiteralPath ${quote(target)}; Write-Output 'ready'`);
  assert.equal(first.exit_code,0,first.stderr);assert.equal(first.stdout.trim(),'ready');assert.equal(first.cwd,target);
  const second=await shell.run('Write-Output ((Get-BhValue).ToCharArray() | ForEach-Object { [int]$_ })');
  assert.equal(second.exit_code,0,second.stderr);assert.equal(String.fromCharCode(...second.stdout.trim().split(/\r?\n/).map(Number)),value);
  const mode=await shell.run('Write-Output $ExecutionContext.SessionState.LanguageMode');
  assert.equal(mode.stdout.trim(),constrained?'ConstrainedLanguage':'FullLanguage');
  const status=await shell.run(`& ${quote(process.env.ComSpec)} /d /c 'exit 7'`);
  assert.equal(status.exit_code,7,status.stderr);
  const ended=await shell.run('exit 3');assert.equal(ended.exit_code,3);assert.match(ended.stderr,/session ended/);
  const next=await shell.run("Write-Output 'recovered'");assert.equal(next.exit_code,0,next.stderr);assert.equal(next.stdout.trim(),'recovered');assert.equal(next.cwd,target);
  if(constrained){
   // Invoke-Expression must not grant .NET file access that this language mode rejects.
   const blocked=await shell.run(`$bhBlocked=$false; try { [System.IO.File]::Exists(${quote(path.join(target,'never-created-\u5b66'))}) | Out-Null } catch { $bhBlocked=$true }; Write-Output $bhBlocked`);
   assert.equal(blocked.exit_code,0,blocked.stderr);assert.equal(blocked.stdout.trim(),'True');
  }
 });
}
