// Compile the REAL Inno script with deliberately non-executable fixture files.
// This proves script syntax only. It cannot be used as a product install test,
// security clearance or runnable release. The compiler output is always removed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
if (process.platform !== 'win32' || process.argv.length !== 3) throw Error('usage: node scripts/check-installer-syntax.mjs <absolute-ISCC-path>');
const compiler=path.resolve(process.argv[2]);
if(!fs.statSync(compiler).isFile())throw Error('compiler_missing');
const root=fileURLToPath(new URL('..',import.meta.url));
const stage=fs.mkdtempSync(path.join(os.tmpdir(),'bh-installer-syntax-'));
try{
 for(const name of ['blackhole.exe','bootstrap/node.exe','bootstrap/node-LICENSE','bootstrap/core-manager-cli.mjs','bootstrap/trust.json','seed/core.zip','installer-preflight-cli.cjs','LICENSE.txt','NOTICE.txt']){
  const file=path.join(stage,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'SYNTAX FIXTURE ONLY: not executable, not a BlackHole distribution.\n');
 }
 for(const channel of ['test','production']){
  const p=spawnSync(compiler,[`/DStageRoot=${stage}`,'/DAppVersion=0.0.1',`/DBuildEnvironment=${channel}`,path.join(root,'installers/windows/desktop.iss')],{encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:1024*1024});
  if(p.error||p.status!==0)throw Error('inno_syntax_failed: '+String(p.stderr||p.stdout||p.error));
  console.log(JSON.stringify({channel,syntaxCompiled:true,installerExecuted:false,productAcceptance:false}));
 }
}finally{fs.rmSync(stage,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
