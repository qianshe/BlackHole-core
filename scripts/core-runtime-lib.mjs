import { createHash, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { CoreDescriptorSchema } from '../packages/contracts/dist/index.js';

const { ZipFile } = yazl;
const { open } = yauzl;
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_MEMBER_BYTES = 192 * 1024 * 1024;
export const MAX_MEMBERS = 20_000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function descriptorPayload(descriptor) { const { signature: _signature, ...unsigned } = descriptor; return Buffer.from(canonicalJson(unsigned)); }
export function signDescriptor(unsigned, privateKey) { return sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64'); }
export function verifyDescriptorSignature(descriptor, publicKey) { return verify(null, descriptorPayload(descriptor), publicKey, Buffer.from(descriptor.signature, 'base64')); }
export function safeArchivePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((p) => p === '..' || p === '')) throw new Error(`core_archive_path_invalid:${name}`);
  return name;
}
export function listFiles(root) {
  const out = [];
  const visit = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name))) {
    const absolute = path.join(dir, entry.name); const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isSymbolicLink()) throw new Error(`core_archive_symlink_rejected:${relative}`);
    if (entry.isDirectory()) visit(absolute); else if (entry.isFile()) out.push({ absolute, relative, size: fs.statSync(absolute).size });
    else throw new Error(`core_archive_member_type_invalid:${relative}`);
  }}; visit(root); return out;
}
export async function writeArchive(file, root, descriptor) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true }); const zip = new ZipFile();
  zip.addBuffer(Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`), 'core-descriptor.json', { mtime: new Date(0), mode: 0o100600 });
  for (const member of descriptor.members) zip.addFile(path.join(root, ...member.path.split('/')), member.path, { mtime: new Date(0), mode: 0o100600, compress: true });
  await new Promise((resolve, reject) => { const output = fs.createWriteStream(file, { flags: 'wx' }); zip.outputStream.pipe(output); output.on('close', resolve); output.on('error', reject); zip.outputStream.on('error', reject); zip.end(); });
}
function readZip(file) { return new Promise((resolve, reject) => open(file, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip))); }
export async function readArchive(file) {
  if (fs.statSync(file).size > MAX_ARCHIVE_BYTES) throw new Error('core_archive_too_large');
  const zip = await readZip(file); const entries = new Map(); let count = 0;
  await new Promise((resolve, reject) => { const fail = (e) => { try { zip.close(); } catch {} reject(e); };
    zip.on('error', fail); zip.on('end', resolve); zip.on('entry', (entry) => { try {
      const name = safeArchivePath(entry.fileName); if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
      if (++count > MAX_MEMBERS) throw new Error('core_archive_too_many_members'); if (entry.uncompressedSize > MAX_MEMBER_BYTES) throw new Error(`core_archive_member_too_large:${name}`);
      if (entries.has(name.toLowerCase())) throw new Error(`core_archive_duplicate_member:${name}`);
      zip.openReadStream(entry, (error, stream) => { if (error) return fail(error); const chunks=[]; let size=0;
        stream.on('data', (chunk) => { size += chunk.length; if (size > MAX_MEMBER_BYTES) stream.destroy(new Error(`core_archive_member_too_large:${name}`)); else chunks.push(chunk); });
        stream.on('error', fail); stream.on('end', () => { entries.set(name.toLowerCase(), { name, bytes: Buffer.concat(chunks) }); zip.readEntry(); });
      });
    } catch (e) { fail(e); }}); zip.readEntry(); });
  return entries;
}
export async function verifyCoreArchive(file, { publicKeys, platform, arch, environment }) {
  const entries = await readArchive(file); const descriptorEntry = entries.get('core-descriptor.json'); if (!descriptorEntry) throw new Error('core_descriptor_missing');
  let raw; try { raw = JSON.parse(descriptorEntry.bytes.toString('utf8')); } catch { throw new Error('core_descriptor_invalid_json'); }
  const parsed = CoreDescriptorSchema.safeParse(raw); if (!parsed.success) throw new Error('core_descriptor_invalid'); const descriptor = parsed.data;
  // A key absent from the caller's trust roots means the host predates the
  // Core's signing rotation (upgrade the host), which is actionable and must
  // not read as archive corruption; a present key that fails verification is.
  const key = publicKeys[descriptor.signingKeyId];
  if (!key) throw new Error(`core_trust_root_missing:${descriptor.signingKeyId}`);
  if (!verifyDescriptorSignature(descriptor, key)) throw new Error('core_archive_signature_invalid');
  if (descriptor.platform !== platform || descriptor.arch !== arch) throw new Error('core_platform_mismatch');
  if (descriptor.environment !== environment) throw new Error('environment_mismatch');
  const declared = new Set(); for (const member of descriptor.members ?? []) { const name=safeArchivePath(member.path); const keyName=name.toLowerCase(); if (declared.has(keyName)) throw new Error(`core_descriptor_duplicate_member:${name}`); declared.add(keyName);
    const actual=entries.get(keyName); if (!actual) throw new Error(`core_member_missing:${name}`); if (actual.bytes.length !== member.size || sha256(actual.bytes) !== member.sha256) throw new Error(`core_member_hash_invalid:${name}`); }
  for (const [keyName, entry] of entries) if (keyName !== 'core-descriptor.json' && !declared.has(keyName)) throw new Error(`core_member_undeclared:${entry.name}`);
  if (descriptor.formatVersion === 2 && descriptor.members.some(member => member.path.startsWith('node/'))) throw new Error('core_host_runtime_must_not_bundle_node');
  for (const required of [...(descriptor.formatVersion === 1 ? [descriptor.nodeEntry] : []), descriptor.daemonEntry, descriptor.webRoot, descriptor.managerEntry]) {
    const normalized = safeArchivePath(required).toLowerCase(); const exists = entries.has(normalized) || [...entries.keys()].some((k) => k.startsWith(`${normalized}/`)); if (!exists) throw new Error(`core_required_entry_missing:${required}`);
  }
  return { descriptor, descriptorHash: sha256(descriptorEntry.bytes), archiveHash: sha256(fs.readFileSync(file)), memberCount: declared.size };
}
export async function extractVerifiedCoreArchive(file, destination, options) {
  const verified = await verifyCoreArchive(file, options);
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isDirectory() || fs.readdirSync(destination).length) throw new Error('core_extract_destination_not_empty');
  } else fs.mkdirSync(destination, { recursive: false });
  const entries = await readArchive(file);
  const descriptorBytes = entries.get('core-descriptor.json')?.bytes;
  if (!descriptorBytes || sha256(descriptorBytes) !== verified.descriptorHash) throw new Error('core_archive_changed');
  for (const member of verified.descriptor.members) {
    const entry = entries.get(member.path.toLowerCase());
    if (!entry) throw new Error(`core_member_missing:${member.path}`);
    if (entry.bytes.length !== member.size || sha256(entry.bytes) !== member.sha256) throw new Error('core_archive_changed');
    const output = path.join(destination, ...member.path.split('/'));
    const relative = path.relative(destination, output);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`core_extract_path_invalid:${member.path}`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, entry.bytes, { flag: 'wx' });
  }
  // Preserve the signed archive's exact descriptor bytes: schema parsing may
  // reorder keys, and the committed identity hashes bytes, not reserialized JSON.
  fs.writeFileSync(path.join(destination, 'core-descriptor.json'), descriptorBytes, { flag: 'wx' });
  return verified;
}
export { sha256 };

/** Verify a committed tree again before executing it; the pointer is not trust. */
export function verifyInstalledCore(root, expectedHash, { publicKeys, platform, arch, environment }) {
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('core_store_link_rejected');
  const descriptorFile = path.join(root, 'core-descriptor.json');
  const descriptorStat = fs.lstatSync(descriptorFile);
  if (!descriptorStat.isFile() || descriptorStat.isSymbolicLink() || descriptorStat.size > 8 * 1024 * 1024) throw new Error('core_descriptor_invalid');
  const bytes = fs.readFileSync(descriptorFile);
  if (sha256(bytes) !== expectedHash) throw new Error('core_descriptor_hash_invalid');
  const descriptor = CoreDescriptorSchema.parse(JSON.parse(bytes.toString('utf8')));
  const key = publicKeys[descriptor.signingKeyId];
  if (!key) throw new Error(`core_trust_root_missing:${descriptor.signingKeyId}`);
  if (environment === 'production' && descriptor.signingKeyId.startsWith('test-')) throw new Error('core_archive_signature_invalid');
  if (!verifyDescriptorSignature(descriptor, key)) throw new Error('core_archive_signature_invalid');
  if (descriptor.platform !== platform || descriptor.arch !== arch) throw new Error('core_platform_mismatch');
  if (descriptor.environment !== environment) throw new Error('environment_mismatch');
  if (descriptor.members.length > MAX_MEMBERS) throw new Error('core_archive_too_many_members');
  // listFiles rejects junctions/symlinks before any member content is opened.
  const actual = new Map(listFiles(root).map((file) => [file.relative, file]));
  const declared = new Set();
  for (const member of descriptor.members) {
    const name = safeArchivePath(member.path);
    if (name.split('/').some((part) => part === '.' || part.includes(':')) || ['core-descriptor.json', 'core-identity.json'].includes(name.toLowerCase())) throw new Error('core_member_path_invalid');
    if (declared.has(name.toLowerCase())) throw new Error('core_descriptor_duplicate_member');
    declared.add(name.toLowerCase());
    const file = actual.get(name);
    if (!file || file.size !== member.size || file.size > MAX_MEMBER_BYTES || sha256(fs.readFileSync(file.absolute)) !== member.sha256) throw new Error(`core_member_hash_invalid:${name}`);
  }
  for (const name of actual.keys()) if (!['core-descriptor.json', 'core-identity.json'].includes(name) && !declared.has(name.toLowerCase())) throw new Error(`core_member_undeclared:${name}`);
  if (descriptor.formatVersion === 2 && descriptor.members.some(member => member.path.startsWith('node/'))) throw new Error('core_host_runtime_must_not_bundle_node');
  for (const entry of [...(descriptor.formatVersion === 1 ? [descriptor.nodeEntry] : []), descriptor.daemonEntry, descriptor.managerEntry, `${descriptor.webRoot}/index.html`]) {
    if (!actual.has(entry) || !declared.has(entry.toLowerCase())) throw new Error(`core_required_entry_missing:${entry}`);
  }
  return { descriptor, descriptorHash: expectedHash };
}
