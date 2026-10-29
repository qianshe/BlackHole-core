import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256 } from './core-runtime-lib.mjs';

const hex = /^[a-f0-9]{64}$/;
function readPinned(file, hash, maxBytes) {
  if (!path.isAbsolute(file) || !hex.test(hash)) throw Error('desktop_node_pin_required');
  const st=fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size<1 || st.size>maxBytes) throw Error('desktop_node_file_invalid');
  const bytes=fs.readFileSync(file);
  if(bytes.length!==st.size || sha256(bytes)!==hash)throw Error('desktop_node_integrity_failed');
  return bytes;
}
export function verifyDesktopNodeInputs(descriptor, options) {
  if(descriptor.formatVersion!==2 || descriptor.runtimeProvider!=='host-node')throw Error('desktop_requires_runtime_neutral_core_v2');
  if(descriptor.members.some(m=>m.path.toLowerCase().startsWith('node/')))throw Error('desktop_core_bundles_duplicate_node');
  const node=readPinned(options.nodeExe,options.nodeSha256,192*1024*1024);
  const license=readPinned(options.nodeLicense,options.nodeLicenseSha256,4*1024*1024);
  return {node,license};
}
export function probeDesktopNode(executable, minimum, expectedPlatform = 'win32', expectedArch = 'x64') {
  const env={...process.env};
  for(const key of Object.keys(env))if(['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase()))delete env[key];
  const program="const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('SELECT 1');d.close();console.log(JSON.stringify({node:process.versions.node,platform:process.platform,arch:process.arch,electron:Boolean(process.versions.electron)}))";
  const run=spawnSync(executable,['-e',program],{env,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:16384});
  if(run.error||run.status!==0)throw Error('desktop_node_capability_check_failed');
  let receipt;try{receipt=JSON.parse(run.stdout)}catch{throw Error('desktop_node_capability_check_failed')}
  if(receipt.platform!==expectedPlatform||receipt.arch!==expectedArch||receipt.electron||!/^\d+[.]\d+[.]\d+$/.test(receipt.node))throw Error('desktop_node_platform_invalid');
  const have=receipt.node.split('.').map(Number),need=minimum.split('.').map(Number);
  if(have.some((v,i)=>have.slice(0,i).every((n,j)=>n===need[j])&&v<need[i]))throw Error('desktop_node_version_incompatible');
  return receipt;
}
/** Copies exactly one Node distribution into the shell payload. The Core ZIP
 * stays byte-identical to the one used by the VS Code bootstrap. */
export function stageDesktopNode(output, descriptor, options) {
  const {node,license}=verifyDesktopNodeInputs(descriptor,options);
  const dir=path.join(output,'bootstrap');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'node.exe'),node,{flag:'wx',mode:0o755});
  fs.writeFileSync(path.join(dir,'node-LICENSE'),license,{flag:'wx'});
  return {nodeRuntime:'shared-cache',files:{'bootstrap/node.exe':sha256(node),'bootstrap/node-LICENSE':sha256(license)}};
}
