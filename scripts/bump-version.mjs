// Bump the version everywhere it must stay in sync (run: pnpm bump [patch|minor|major|X.Y.Z]).
//
// Why a script: the version lives in THREE places and a mismatch ships a bundle
// whose reported version disagrees with the vsix manifest — the exact bug that
// made 0.3.107's version string wrong. This bumps all three atomically and
// refuses to run if they were already out of sync.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT_PKG = path.join(ROOT, 'package.json');
const EXT_PKG = path.join(ROOT, 'packages', 'vscode', 'package.json');
const VERSION_TS = path.join(ROOT, 'src', 'version.ts');

const SEMVER = /^\d+\.\d+\.\d+$/;

const readVersion = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).version;
const readTsVersion = (file) => {
  const m = /export const VERSION = '([^']+)'/.exec(fs.readFileSync(file, 'utf8'));
  if (!m) throw new Error(`cannot find VERSION in ${file}`);
  return m[1];
};

const current = readVersion(ROOT_PKG);
const extCurrent = readVersion(EXT_PKG);
const tsCurrent = readTsVersion(VERSION_TS);

if (current !== extCurrent || current !== tsCurrent) {
  console.error('version drift — fix before bumping:');
  console.error(`  package.json            ${current}`);
  console.error(`  packages/vscode         ${extCurrent}`);
  console.error(`  src/version.ts          ${tsCurrent}`);
  process.exit(1);
}

const arg = (process.argv[2] ?? 'patch').trim();
let next;
if (SEMVER.test(arg)) {
  next = arg;
} else if (arg === 'patch' || arg === 'minor' || arg === 'major') {
  const [maj, min, pat] = current.split('.').map(Number);
  next = arg === 'major' ? `${maj + 1}.0.0`
    : arg === 'minor' ? `${maj}.${min + 1}.0`
      : `${maj}.${min}.${pat + 1}`;
} else {
  console.error(`usage: pnpm bump [patch|minor|major|X.Y.Z]  (got "${arg}")`);
  process.exit(1);
}

if (next === current) {
  console.log(`version already ${current} — nothing to do`);
  process.exit(0);
}

// exact, formatting-preserving rewrites
const swapJson = (file, from, to) => {
  const src = fs.readFileSync(file, 'utf8');
  const out = src.replace(new RegExp(`("version":\\s*")${from.replace(/\./g, '\\.')}(")`), `$1${to}$2`);
  if (out === src) throw new Error(`could not rewrite version in ${file}`);
  fs.writeFileSync(file, out);
};
const swapTs = (file, from, to) => {
  const src = fs.readFileSync(file, 'utf8');
  const out = src.replace(`export const VERSION = '${from}'`, `export const VERSION = '${to}'`);
  if (out === src) throw new Error(`could not rewrite version in ${file}`);
  fs.writeFileSync(file, out);
};

swapJson(ROOT_PKG, current, next);
swapJson(EXT_PKG, current, next);
swapTs(VERSION_TS, current, next);

// verify
const after = [readVersion(ROOT_PKG), readVersion(EXT_PKG), readTsVersion(VERSION_TS)];
if (after.some((v) => v !== next)) {
  console.error(`verify failed after bump: ${JSON.stringify(after)}`);
  process.exit(1);
}
console.log(`${current} -> ${next}  (package.json, packages/vscode/package.json, src/version.ts)`);
