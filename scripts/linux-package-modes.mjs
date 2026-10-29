import fs from 'node:fs';
import path from 'node:path';
// Public package payloads must not inherit the signing-key umask.
export function normalizeDebianPayloadModes(root,environment='production') {
 if(!['production','test'].includes(environment))throw Error('linux_package_environment_invalid');
 const opt=environment==='test'?'opt/BlackHole-Test':'opt/BlackHole';
 const command=environment==='test'?'blackhole-desktop-test':'blackhole-desktop';
 const visit = at => {
  const stat=fs.lstatSync(at);
  if(stat.isSymbolicLink())throw Error('linux_package_link_rejected');
  if(stat.isDirectory()){
   fs.chmodSync(at,0o755);
   for(const name of fs.readdirSync(at))visit(path.join(at,name));
  }else if(stat.isFile())fs.chmodSync(at,0o644);
  else throw Error('linux_package_entry_invalid');
 };
 visit(root);
 for(const name of [opt+'/blackhole',opt+'/bootstrap/node.exe','usr/bin/'+command]) {
  fs.chmodSync(path.join(root,name),0o755);
 }
}
