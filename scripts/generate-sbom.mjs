// Generates a CycloneDX 1.5 SBOM for the shipped product surface: production
// npm packages bundled into the VSIX/Core/Web, the Go modules in the Desktop
// launcher, and the pinned runtime/tool components that ship inside the Core
// (bundled Node.js). Usage:
//   node scripts/generate-sbom.mjs --output <sbom.cdx.json> [--artifacts <artifact-manifest.json>]
// The output is deterministic (sorted components, no timestamps from input
// files) except for the generation timestamp and serial number.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith('--') ? [v.slice(2), a[i + 1]] : null).filter(Boolean));
if (!args.output) throw new Error('missing --output');

function npmComponents() {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const raw = execFileSync(pnpm, ['-r', 'licenses', 'list', '--prod', '--json'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64e6 });
  const seen = new Map();
  for (const [license, pkgs] of Object.entries(JSON.parse(raw))) {
    for (const p of pkgs) for (const version of p.versions) {
      const key = `${p.name}@${version}`;
      if (!seen.has(key)) seen.set(key, { type: 'library', name: p.name, version, licenses: [{ license: { id: /^[A-Za-z0-9-.+]+$/.test(license) ? license : undefined, name: license } }], purl: `pkg:npm/${encodeURIComponent(p.name)}@${version}`, properties: [{ name: 'blackhole:ecosystem', value: 'npm' }] });
    }
  }
  return [...seen.values()];
}
function goComponents() {
  try {
    const raw = execFileSync('go', ['list', '-m', '-json', 'all'], { cwd: path.join(ROOT, 'packages/desktop-launcher'), encoding: 'utf8', maxBuffer: 64e6 });
    const components = [];
    for (const block of raw.split(/^\n(?=\{)/m)) {
      const mod = JSON.parse(block);
      if (!mod.Path || !mod.Version) continue;
      components.push({ type: 'library', name: mod.Path, version: mod.Version, purl: `pkg:golang/${mod.Path}@${mod.Version}`, properties: [{ name: 'blackhole:ecosystem', value: 'go' }, ...(mod.Main ? [{ name: 'blackhole:main-module', value: 'true' }] : [])] });
    }
    return components;
  } catch { return []; }
}
const components = [...npmComponents(), ...goComponents()];
components.push({ type: 'runtime', name: 'Node.js (bundled in Core)', version: process.versions.node, properties: [{ name: 'blackhole:ecosystem', value: 'runtime' }, { name: 'blackhole:distribution', value: 'Core node/ member, hash-pinned by the signed Core descriptor' }] });
if (args.artifacts) {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(args.artifacts), 'utf8'));
  components.push({ type: 'application', name: 'BlackHole Shared Core', version: manifest.version, hashes: [{ alg: 'SHA-256', content: manifest.seed.descriptorSha256 }], properties: [{ name: 'blackhole:artifact', value: manifest.seed.archive }, { name: 'blackhole:descriptor', value: manifest.seed.versionName }] });
}
components.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const sbom = {
  bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${randomUUID()}`, version: 1,
  metadata: { timestamp: new Date().toISOString(), tools: [{ vendor: 'BlackHole', name: 'generate-sbom.mjs', version: '1' }], component: { type: 'application', name: 'BlackHole', version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version } },
  components,
};
fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
fs.writeFileSync(path.resolve(args.output), JSON.stringify(sbom, null, 2) + '\n', { flag: 'w' });
console.log(JSON.stringify({ ok: true, output: path.resolve(args.output), components: components.length }));
