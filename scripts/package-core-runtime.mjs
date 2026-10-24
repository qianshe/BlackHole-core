import fs from 'node:fs';
import path from 'node:path';
import { CoreDescriptorSchema } from '../packages/contracts/dist/index.js';
import { listFiles, sha256, signDescriptor, writeArchive } from './core-runtime-lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((v,i,a)=>v.startsWith('--')?[v.slice(2),a[i+1]]:null).filter(Boolean));
const hostNode = args['runtime-provider'] === 'host-node';
if (args['runtime-provider'] !== undefined && !hostNode) throw new Error('core_runtime_provider_invalid');
for (const k of ['input','output','private-key','key-id','runtime-version','build-id','platform','arch','environment','cloud-origin','daemon-version','web-build-id',hostNode?'node-min-version':'node-version']) if (!args[k]) throw new Error(`missing --${k}`);
if (args.environment === 'production' && /^test(?:-|$)/i.test(args['key-id'])) throw new Error('production_rejects_test_trust_root');
if (hostNode && (args['node-entry'] || args['node-version'])) throw new Error('core_host_runtime_cannot_embed_node');
const root = path.resolve(args.input);
const files = listFiles(root);
if (hostNode && files.some(f=>f.relative.startsWith('node/'))) throw new Error('core_host_runtime_must_not_bundle_node');
const unsigned = {
  formatVersion: hostNode ? 2 : 1,
  runtimeId: 'blackhole-core',
  runtimeVersion: args['runtime-version'],
  buildId: args['build-id'], platform: args.platform, arch: args.arch,
  environment: args.environment, cloudOrigin: args['cloud-origin'],
  coreProtocol: {min:1,max:1}, capabilities: ['web-ui'],
  ...(hostNode
    ? {runtimeProvider:'host-node', nodeMinVersion:args['node-min-version']}
    : {nodeVersion:args['node-version'], nodeEntry:args['node-entry']??(args.platform==='win32'?'node/node.exe':'node/bin/node')}),
  daemonVersion: args['daemon-version'], daemonEntry: args['daemon-entry']??'daemon/cli.js',
  webBuildId: args['web-build-id'], webRoot: args['web-root']??'web',
  managerEntry: args['manager-entry']??'host/core-manager-cli.mjs',
  dataSchema: {min:1,max:1}, migrationPolicy: 'explicit',
  members: files.map(f=>({path:f.relative,sha256:sha256(fs.readFileSync(f.absolute)),size:f.size})),
  signingKeyId: args['key-id'], signatureAlgorithm:'ed25519', createdAt:args['created-at']??new Date().toISOString()
};
const descriptor = CoreDescriptorSchema.parse({...unsigned,signature:signDescriptor(unsigned,fs.readFileSync(args['private-key']))});
await writeArchive(path.resolve(args.output),root,descriptor);
console.log(JSON.stringify({ok:true,output:path.resolve(args.output),members:descriptor.members.length,formatVersion:descriptor.formatVersion}));
