// Runs real installers ONLY on a disposable GitHub-hosted runner.
// Headless bootstrap/install evidence, not a claim of interactive GUI acceptance.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
if(process.env.GITHUB_ACTIONS!=='true'||!process.env.RUNNER_TEMP)throw Error('disposable_github_runner_required');
const layout=path.resolve(process.argv[2]??'');
const audit=JSON.parse(fs.readFileSync(path.join(layout,'distribution-audit.json')));
assert.equal(audit.environment,'production');
assert.equal(audit.platform,process.platform);assert.equal(audit.arch,process.arch);
assert.equal(audit.core.signingKeyId,'prod-host-node-v1');
const root=fs.realpathSync(fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'bh-installer-')));
const home=path.join(root,'home'),data=path.join(home,'.blackhole');fs.mkdirSync(data,{recursive:true});
const sentinel=path.join(data,'acceptance-user-data.txt');fs.writeFileSync(sentinel,'retain me');
const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),BLACKHOLE_TUNNEL:'off',BLACKHOLE_SEMANTIC:'off'};
delete env.BLACKHOLE_DB;delete env.BLACKHOLE_PROXY_CONFIG;delete env.BLACKHOLE_SEMANTIC_KEY_FILE;
const installer=path.join(layout,audit.installer.file);
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;await new Promise(r=>server.close(r));
let mounted=false,installed=false,started=false,exe,appRoot;
function run(command,args,extra={}) {
 const r=spawnSync(command,args,{env,encoding:'utf8',timeout:120000,windowsHide:true,...extra});
 if(r.status!==0)throw Error('installer_smoke_command_failed:'+path.basename(command)+':'+String(r.error?.message??r.stderr??r.stdout).slice(-1800));
 return r.stdout;
}
function install() {
 if(process.platform==='win32') {
  appRoot=path.join(root,'app');
  run(installer,['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CURRENTUSER','/DIR='+appRoot,'/LOG='+path.join(root,'setup.log')]);
  exe=path.join(appRoot,'blackhole.exe');
 } else if(process.platform==='darwin') {
  appRoot=path.join(root,'installed','BlackHole.app','Contents/MacOS');
  fs.mkdirSync(path.join(root,'installed'),{recursive:true});
  fs.cpSync(path.join(root,'mount','BlackHole.app'),path.join(root,'installed','BlackHole.app'),{recursive:true,force:true});
  run('codesign',['--verify','--deep','--strict',path.join(root,'installed','BlackHole.app')]);
  assert.equal(audit.signing.macos.notarized,false);assert.equal(audit.signing.macos.identity,'ad-hoc');
  exe=path.join(appRoot,'blackhole');
 } else {
  run('sudo',['dpkg','--install',installer]);
  appRoot='/opt/BlackHole';exe=path.join(appRoot,'blackhole');
 }
 installed=true;
}
function launch(args) {
 const out=run(exe,[...args,'--print']);
 const result=JSON.parse(out.trim());assert.equal(result.ok,true,out);return result;
}
try {
 if(process.platform==='darwin') {
  fs.mkdirSync(path.join(root,'mount'));
  run('hdiutil',['attach',installer,'-readonly','-nobrowse','-noautoopen','-mountpoint',path.join(root,'mount')]);mounted=true;
 }
 install();
 const before=fs.readFileSync(path.join(appRoot,'bootstrap/node.exe'));
 assert.equal(createHash('sha256').update(before).digest('hex'),audit.files['bootstrap/node.exe']);
 launch(['--provision-only','--port',String(port)]);
 const result=launch(['--no-browser','--no-tray','--port',String(port)]);started=true;
 assert.ok(result.receipt);
 const health=await fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(10000)});
 assert.equal(health.status,200);assert.equal((await health.json()).version,audit.version);
 launch(['--stop','--confirm-maintenance','--port',String(port)]);started=false;
 install(); // repeat installation preserves the isolated profile
 launch(['--apply-bundled-core','--port',String(port)]);
 assert.equal(fs.readFileSync(sentinel,'utf8'),'retain me');
 if(process.platform==='win32')run(path.join(appRoot,'unins000.exe'),['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART']);
 else if(process.platform==='linux')run('sudo',['dpkg','--remove','blackhole-desktop']);
 else fs.rmSync(path.join(root,'installed','BlackHole.app'),{recursive:true,force:true});
 installed=false;
 assert.equal(fs.existsSync(exe),false);assert.equal(fs.readFileSync(sentinel,'utf8'),'retain me');
 const receipt={schemaVersion:1,sourceSha:process.env.GITHUB_SHA,platform:process.platform,arch:process.arch,version:audit.version,installerSha256:audit.installer.sha256,
  installed:true,reinstalled:true,bootstrapHealth:true,nodePinVerified:true,uninstalled:true,userDataRetained:true,nativeUIAccepted:false};
 fs.writeFileSync(path.join(layout,'installer-smoke.json'),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(receipt));
} finally {
 if(started&&exe&&fs.existsSync(exe))try{launch(['--stop','--confirm-maintenance','--port',String(port)])}catch(e){console.error('cleanup_stop_failed:'+e.message)}
 if(installed&&process.platform==='linux')try{run('sudo',['dpkg','--remove','blackhole-desktop'])}catch(e){console.error('cleanup_remove_failed:'+e.message)}
 if(mounted)run('hdiutil',['detach',path.join(root,'mount')]);
 fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:250});
}
