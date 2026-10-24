// Measures a real host-Node Core without creating persistent signing secrets.
// This ephemeral test signature cannot be trusted by the product release channel.
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { CoreDescriptorSchema } from '../packages/contracts/dist/index.js';
import { listFiles, sha256, signDescriptor, verifyCoreArchive, writeArchive } from './core-runtime-lib.mjs';
import { resolveBuildConfig } from '../packages/vscode/build-config.mjs';

const [layoutArg, archiveArg] = process.argv.slice(2);
if (!layoutArg || !archiveArg || process.argv.length !== 4) throw new Error('usage: node scripts/core-host-node-size-smoke.mjs LAYOUT NEW_ARCHIVE');
const layout=path.resolve(layoutArg), archive=path.resolve(archiveArg);
if (fs.existsSync(archive)) throw new Error('fresh_output_required');
if (fs.existsSync(path.join(layout,'node'))) throw new Error('core_host_runtime_must_not_bundle_node');
const files=listFiles(layout);
const { publicKey, privateKey }=generateKeyPairSync('ed25519');
const version=JSON.parse(fs.readFileSync('package.json','utf8')).version;
const unsigned={
  formatVersion:2, runtimeProvider:'host-node', nodeMinVersion:'22.13.0',
  runtimeId:'blackhole-core', runtimeVersion:version, buildId:'test-v2-host-20261016',
  platform:'win32',arch:'x64',environment:'test',cloudOrigin:resolveBuildConfig('test').origin,
  coreProtocol:{min:1,max:1},capabilities:['web-ui'],
  daemonVersion:version,daemonEntry:'daemon/cli.js',
  webBuildId:'test-v2-host-20261016',webRoot:'web',managerEntry:'host/core-manager-cli.mjs',
  dataSchema:{min:1,max:1},migrationPolicy:'explicit',
  members:files.map(file=>({path:file.relative,sha256:sha256(fs.readFileSync(file.absolute)),size:file.size})),
  signingKeyId:'test-ephemeral-do-not-install',signatureAlgorithm:'ed25519',createdAt:'2026-10-16T00:00:00.000Z'
};
const descriptor=CoreDescriptorSchema.parse({...unsigned,signature:signDescriptor(unsigned,privateKey)});
await writeArchive(archive,layout,descriptor);
const verified=await verifyCoreArchive(archive,{publicKeys:{[descriptor.signingKeyId]:publicKey},platform:'win32',arch:'x64',environment:'test'});
if(verified.descriptorHash.length!==64 || verified.memberCount!==files.length)throw new Error('audit_mismatch');
const s=fs.statSync(archive);
console.log(JSON.stringify({ok:true,kind:'ephemeral-signed-v2-review',installable:false,formatVersion:descriptor.formatVersion,version,rawBytes:files.reduce((s,f)=>s+f.size,0),compressedBytes:s.size,megabytes:Number((s.size/1e6).toFixed(3)),archiveSha256:verified.archiveHash,memberCount:files.length,nodeBundled:false}));
