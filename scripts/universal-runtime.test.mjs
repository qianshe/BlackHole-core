import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
test('POSIX proxy lifecycle imports no Windows native runtime',()=>{
 const code=`import Module from 'node:module';
 Object.defineProperty(process,'platform',{value:'linux'});
 const load=Module._load;Module._load=function(id,...args){if(id==='koffi')throw new Error('unexpected Koffi import on POSIX');return load.call(this,id,...args);};
 const m=await import('./dist/proxy/win32job.js');
 if(m.assignPidToKillOnCloseJob(1)!==null)throw new Error('unexpected Windows job on POSIX');m.closeJobHandle(null);`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:root,encoding:'utf8',timeout:15000});
 assert.equal(r.status,0,r.stderr);
});
test('the requested extension version and publisher remain unchanged by packaging',()=>{
 const root=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 const p=JSON.parse(readFileSync(new URL('../packages/vscode/package.json',import.meta.url),'utf8'));
 assert.equal(p.version,root.version);assert.equal(p.publisher,'qianshe');
});
