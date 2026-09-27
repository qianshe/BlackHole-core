// Downloads the @napi-rs/keyring native packages for every VSIX target into
// .cache/keyring-prebuilds so a universal package can ship them all.
// Version and targets come from scripts/desktop-toolchain.json; each tarball
// is checked against the registry's sha512 integrity before extraction.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolchain = JSON.parse(fs.readFileSync(path.join(root, 'scripts/desktop-toolchain.json'), 'utf8'));
const spec = toolchain.workspace?.['@napi-rs/keyring'] ?? toolchain.planned?.['@napi-rs/keyring'];
if (!spec) throw new Error('@napi-rs/keyring missing from desktop-toolchain.json');
const out = path.join(root, '.cache/keyring-prebuilds');
fs.mkdirSync(out, { recursive: true });

for (const target of spec.prebuiltTargets) {
  const name = `@napi-rs/keyring-${target}`;
  const dest = path.join(out, `keyring-${target}`);
  const marker = path.join(dest, 'package.json');
  if (fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, 'utf8')).version === spec.version) { console.log(`ok   ${name}`); continue; }
  const meta = await (await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}/${spec.version}`)).json();
  const { tarball, integrity } = meta.dist ?? {};
  if (!tarball || !integrity?.startsWith('sha512-')) throw new Error(`${name}: no tarball/integrity`);
  const buf = Buffer.from(await (await fetch(tarball)).arrayBuffer());
  if (`sha512-${createHash('sha512').update(buf).digest('base64')}` !== integrity) throw new Error(`${name}: integrity mismatch`);
  const tgz = path.join(out, `${target}.tgz`);
  fs.writeFileSync(tgz, buf);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  // relative paths: GNU tar (Git for Windows) reads "D:\..." as a remote host
  execFileSync('tar', ['-xzf', `${target}.tgz`, '-C', `keyring-${target}`, '--strip-components=1'], { cwd: out });
  fs.rmSync(tgz);
  console.log(`got  ${name}@${spec.version}`);
}
