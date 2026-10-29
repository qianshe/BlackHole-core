import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/settings/desktopUpdateClient.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {parseDesktopUpdate,readDesktopUpdate}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
test('ordinary browser has no update installation or native fallback',async()=>{
 assert.equal(await readDesktopUpdate('status'),null);assert.doesNotMatch(source,/fetch\(|location\.href|window\.open/);
});
test('status transport strips paths, URLs, credentials and unknown fields',()=>{
 const result=parseDesktopUpdate(JSON.stringify({state:'available',currentVersion:'0.3.201',availableVersion:'0.3.202',installerUrl:'https://untrusted',token:'secret'}));
 assert.deepEqual(result,{state:'available',currentVersion:'0.3.201',availableVersion:'0.3.202'});
});
test('malformed or overlarge native replies do not create UI actions',()=>{
 for(const s of ['null','{}','garbage',' '.repeat(5000),JSON.stringify({state:'install-now',currentVersion:'0.3.201'}),JSON.stringify({state:'available',currentVersion:'0.3.201',availableVersion:'<script>'})])assert.equal(parseDesktopUpdate(s),null);
});

test('download status exposes progress only and strips attempt, path and credentials',()=>{
 const input={state:'available',currentVersion:'0.3.201',availableVersion:'0.3.202',download:{state:'downloading',version:'0.3.202',bytes:500000,totalBytes:2000000,attempt:'local-only',installerUrl:'https://private.invalid',path:'C:/private',token:'secret'}};
 const result=parseDesktopUpdate(JSON.stringify(input));
 assert.deepEqual(result.download,{state:'downloading',version:'0.3.202',bytes:500000,totalBytes:2000000});
 for(const invalid of [{bytes:-1},{bytes:2000001},{totalBytes:2**40},{state:'installing'},{version:'<script>'}])assert.equal(parseDesktopUpdate(JSON.stringify({...input,download:{...input.download,...invalid}})).download,undefined);
});
test('cancel is a fixed native action without a request body or browser fallback',async()=>{
 assert.equal(await readDesktopUpdate('cancel-download'),null);
 let called;
 globalThis.blackholeDesktopUpdateAction=async action=>{called=action;return JSON.stringify({state:'current',currentVersion:'0.3.201'})};
 try{await readDesktopUpdate('cancel-download');assert.equal(called,'cancel-download')}finally{delete globalThis.blackholeDesktopUpdateAction}
});
test('update panel offers progress and cancellation without a web installer launch',()=>{
 const view=fs.readFileSync(new URL('../src/settings/DesktopUpdates.tsx',import.meta.url),'utf8');
 assert.match(view,/<progress[^>]*aria-label="更新下载进度"/);assert.match(view,/cancel-download/);assert.match(view,/取消下载/);
 assert.doesNotMatch(view,/fetch\(|location\.href|window\.open|installerUrl/);
});
