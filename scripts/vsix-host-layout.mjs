// Shared by the real packager and archive audit. Runtime-neutral code packages
// remain signed; dropping Node never disables descriptor/member verification.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoreBootstrapSchema, HostCoreBuildSchema } from '../packages/contracts/dist/index.js';
import { createPublicKey } from 'node:crypto';
import { verifyCoreArchive, readArchive, sha256 } from './core-runtime-lib.mjs';

export function hostExtensionFile(relative) {
  if (/\.(?:map|vsix)$|(?:^|\/)\.env(?:\.|$)/i.test(relative)) return false;
  if (!relative.startsWith('dist/')) return /^(?:media\/|licenses\/|LICENSE$|NOTICE$|README\.md$|CHANGELOG\.md$|SUPPORT\.md$|THIRD_PARTY_(?:LICENSES|NOTICES)\.md$)/.test(relative);
  return ['dist/extension.js','dist/settings/settings.js','dist/settings/settings.css','dist/cloud-build.json','dist/mermaid-LICENSE'].includes(relative);
}
export async function hostCoreInputs(archive, publicKey, keyId, build, corePackage, coreUrl, previousTestRoot) {
  if (!archive || !publicKey || !keyId) throw Error('host_core_reference_required: supply a signed v2 code archive and verification public key');
  const trust = { environment: build.environment, publicKeys: { [keyId]: publicKey } };
  // During local Test upgrades an older ephemeral-signed Core may still be
  // selected or pinned by an unrecovered start record. Preserve only its PUBLIC
  // trust root so Manager can verify and safely retire it; never import a
  // previous private key or permit a Test root into a production package.
  const priorRoots = Array.isArray(previousTestRoot) ? previousTestRoot : previousTestRoot ? [previousTestRoot] : [];
  if (priorRoots.length > 7) throw Error('previous_test_trust_invalid');
  for (const previous of priorRoots) {
    if (build.environment !== 'test' || typeof previous?.keyId !== 'string' || !/^test[-_][A-Za-z0-9_-]{1,100}$/.test(previous.keyId)
      || Object.hasOwn(trust.publicKeys, previous.keyId) || typeof previous.publicKey !== 'string'
      || previous.publicKey.length > 4096 || !previous.publicKey.includes('-----BEGIN PUBLIC KEY-----')
      || previous.publicKey.includes('PRIVATE KEY'))
      throw Error('previous_test_trust_invalid');
    try {
      if (createPublicKey(previous.publicKey).asymmetricKeyType !== 'ed25519') throw Error('invalid_key_type');
    } catch { throw Error('previous_test_trust_invalid'); }
    trust.publicKeys[previous.keyId] = previous.publicKey;
  }
  const verified = await verifyCoreArchive(archive, { ...trust, platform: 'win32', arch: 'x64' });
  if (verified.descriptor.formatVersion !== 2 || verified.descriptor.runtimeProvider !== 'host-node') throw Error('vsix_node_bundling_forbidden: require Core v2 host-node');
  if (verified.descriptor.cloudOrigin !== build.origin) throw Error('host_core_cloud_mismatch');
  // A host can ship a newer/older Core version, but only if its API contract is
  // usable by this VSIX. Version equality is intentionally not required.
  if (verified.descriptor.coreProtocol.min > 1 || verified.descriptor.coreProtocol.max < 1 ||
    !verified.descriptor.capabilities.includes('web-ui')) throw Error('bundled_core_host_protocol_incompatible');
  if (!['thin','offline-code'].includes(corePackage)) throw Error('host_core_package_invalid');
  if (corePackage === 'offline-code' && coreUrl) throw Error('embedded_core_does_not_use_url');
  const reference = CoreBootstrapSchema.parse({ schemaVersion:1, environment:build.environment, cloudOrigin:build.origin,
    platform:verified.descriptor.platform, arch:verified.descriptor.arch, runtimeVersion:verified.descriptor.runtimeVersion,
    buildId:verified.descriptor.buildId, descriptorHash:verified.descriptorHash, archiveHash:verified.archiveHash,
    archiveBytes:fs.statSync(archive).size,
    source:corePackage==='thin'?{kind:'download',url:coreUrl}:{kind:'embedded'} });
  return { reference, trust, verified, archive };
}
export function stageHostCore(contents, managerEntry, input) {
  const dir = path.join(contents,'dist/manager'); fs.mkdirSync(dir,{recursive:true});
  fs.copyFileSync(managerEntry,path.join(dir,'core-manager-cli.mjs'));
  fs.writeFileSync(path.join(dir,'core-bootstrap.json'),JSON.stringify(input.reference,null,2)+'\n',{flag:'wx'});
  fs.writeFileSync(path.join(dir,'trust.json'),JSON.stringify(input.trust,null,2)+'\n',{flag:'wx'});
  if (input.reference.source.kind === 'embedded') {
    fs.mkdirSync(path.join(contents,'dist/core'),{recursive:true});
    fs.copyFileSync(input.archive,path.join(contents,'dist/core/core.zip'));
  }
  const infoFile=path.join(contents,'dist/cloud-build.json');
  const info=JSON.parse(fs.readFileSync(infoFile,'utf8'));
  delete info.daemonSha256; delete info.processSupervisorSha256;
  fs.writeFileSync(infoFile,JSON.stringify(info,null,2)+'\n');
  const hash=name=>sha256(fs.readFileSync(path.join(dir,name)));
  return { mode:'host-node', platform:input.reference.platform, arch:input.reference.arch,
    bootstrapSha256:hash('core-bootstrap.json'),managerSha256:hash('core-manager-cli.mjs'),trustSha256:hash('trust.json') };
}

export async function auditHostVsix(file, expected, expectedBuild) {
  const entries = await readArchive(file);
  const get = name => { const entry=entries.get(name.toLowerCase()); assert.ok(entry,'missing '+name); return entry.bytes; };
  const manifest = JSON.parse(get('extension/package.json'));
  const info = JSON.parse(get('extension/dist/cloud-build.json'));
  assert.equal(manifest.version,expected.version); assert.equal(manifest.name,expected.name); assert.equal(manifest.publisher,expected.publisher);
  if(expectedBuild) assert.deepEqual(manifest.blackholeBuild,expectedBuild);
  const cloud=manifest.blackholeBuild;
  assert.equal(info.environment,cloud.environment);assert.equal(info.origin,cloud.origin);assert.equal(info.entitlementPublicKey,cloud.entitlementPublicKey);
  assert.equal(manifest.contributes.configuration.properties['blackhole.port'].default,7306);
  assert.equal(manifest.contributes.configuration.properties['blackhole.daemonEntry'],undefined);
  for(const name of entries.keys()) {
    assert.ok(!/^extension\/dist\/(?:daemon|node|node_modules|workspace|win32|seed-core)\//.test(name),'redundant backend in VSIX: '+name);
    assert.ok(!/(?:^|\/)(?:node(?:\.exe)?|cloudflared(?:\.exe)?|private\.pem|blackhole\.db)$|\.map$/i.test(name),'runtime/data/debug file in VSIX');
  }
  for(const [name,key] of [['extension.js','extensionSha256'],['settings/settings.js','settingsSha256'],['settings/settings.css','settingsCssSha256']]) assert.equal(sha256(get('extension/dist/'+name)),info[key]);
  assert.ok(get('extension/dist/extension.js').includes(Buffer.from(cloud.origin)));
  for(const name of ['LICENSE.txt','NOTICE','readme.md','THIRD_PARTY_LICENSES.md','THIRD_PARTY_NOTICES.md'])get('extension/'+name);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bh-host-vsix-audit-'));
  try {
    for(const name of ['core-manager-cli.mjs','core-bootstrap.json','trust.json']) {
      const dest=path.join(temp,'dist/manager',name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,get('extension/dist/manager/'+name));
    }
    const pin=HostCoreBuildSchema.parse(manifest.blackholeSharedCore);
    for(const [name,key] of [['core-bootstrap.json','bootstrapSha256'],['core-manager-cli.mjs','managerSha256'],['trust.json','trustSha256']])assert.equal(sha256(get('extension/dist/manager/'+name)),pin[key]);
    const reference=CoreBootstrapSchema.parse(JSON.parse(get('extension/dist/manager/core-bootstrap.json')));
    assert.equal(reference.environment,cloud.environment);assert.equal(reference.cloudOrigin,cloud.origin);assert.equal(reference.platform,pin.platform);assert.equal(reference.arch,pin.arch);
    const pinnedTrust=JSON.parse(get('extension/dist/manager/trust.json'));
    assert.equal(pinnedTrust.environment,cloud.environment);assert.ok(Object.keys(pinnedTrust.publicKeys).length>0);
    for(const [id,key] of Object.entries(pinnedTrust.publicKeys)){assert.equal(createPublicKey(key).asymmetricKeyType,'ed25519');if(cloud.environment==='production')assert.doesNotMatch(id,/^test[-_]/i);}
    const platform=reference.platform+'-'+reference.arch;
    assert.ok(get('extension.vsixmanifest').toString('utf8').includes(`TargetPlatform="${platform}"`),'host VSIX must declare its platform');
    const seedName='extension/dist/core/core.zip';
    if(reference.source.kind==='embedded') {
      const bytes=get(seedName);assert.equal(bytes.length,reference.archiveBytes);assert.equal(sha256(bytes),reference.archiveHash);
      const archive=path.join(temp,'core.zip');fs.writeFileSync(archive,bytes);
      const trust=JSON.parse(get('extension/dist/manager/trust.json'));
      const verified=await verifyCoreArchive(archive,{...trust,platform:reference.platform,arch:reference.arch});
      assert.equal(verified.descriptor.formatVersion,2);assert.equal(verified.descriptorHash,reference.descriptorHash);
    } else assert.ok(!entries.has(seedName));
    const bytes=fs.statSync(file).size;
    assert.ok(bytes< (reference.source.kind==='embedded'?8:3)*1024*1024,'VSIX size budget exceeded');
    return {file:path.resolve(file),extensionId:manifest.publisher+'.'+manifest.name,version:manifest.version,target:platform,
      bytes,sha256:sha256(fs.readFileSync(file)),files:entries.size,mode:'host-node',nodeBundled:false,
      coreCodeBundled:reference.source.kind==='embedded',coreVersion:reference.runtimeVersion,coreArchiveBytes:reference.archiveBytes,
      coreArchiveSha256:reference.archiveHash,buildEnvironment:cloud.environment,cloudOrigin:cloud.origin,sharedSettingsRenderer:true};
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
