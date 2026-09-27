import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { parseBuildArgs, buildDefines, daemonBuildDefines } from './build-config.mjs';
import { join } from 'node:path';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const { build: cloudBuild } = parseBuildArgs(process.argv.slice(2).filter(arg => arg !== '--watch'));
console.log('Cloud build: ' + cloudBuild.environment + ' -> ' + cloudBuild.origin);

const common = { bundle: true, platform: 'node', format: 'cjs', logLevel: 'info' };

// Release hardening (plan 6.14). Production only; test builds stay readable for debugging.
//  O1 minify + keepNames; O2 source maps written to <repo>/.tmp/sourcemaps/<version>/,
//  never shipped; O3 light obfuscation of the entitlement modules; O4 integrity seal.
const production = cloudBuild.environment === 'production';
const hardening = production ? { minify: true, keepNames: true, sourcemap: 'external' } : {};
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const SOURCEMAP_DIR = join(process.cwd(), '../../.tmp/sourcemaps', version);
// Fixed-width slot: sealing pads to the same length so source-map columns stay valid.
const INTEGRITY_SLOT = '<<BHI:' + ' '.repeat(8192) + ':BHI>>';
const OBFUSCATE = /[\\/]src[\\/](cloud[\\/]entitlement-gate|account[\\/]service)\.ts$/;
const obfuscatePlugin = {
  name: 'obfuscate-entitlement',
  setup(build) {
    build.onLoad({ filter: OBFUSCATE }, async (args) => {
      const { default: JavaScriptObfuscator } = await import('javascript-obfuscator');
      const ts = await esbuild.transform(readFileSync(args.path, 'utf8'), { loader: 'ts', format: 'esm', target: 'node22', sourcefile: args.path });
      const out = JavaScriptObfuscator.obfuscate(ts.code, {
        target: 'node', sourceType: 'module', compact: true, seed: 0,
        controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.5,
        stringArray: true, stringArrayEncoding: ['base64'], stringArrayThreshold: 0.75,
        deadCodeInjection: false, selfDefending: false, debugProtection: false,
        renameGlobals: false, identifierNamesGenerator: 'mangled', unicodeEscapeSequence: false,
      });
      return { contents: out.getObfuscatedCode(), loader: 'js' };
    });
  },
};

// The extension host side: only 'vscode' stays external.
const extensionOptions = {
  ...common,
  entryPoints: ['src/extension.ts'],
  define: buildDefines(cloudBuild),
  outfile: 'dist/extension.js',
  external: ['vscode'],
  target: 'node20',
  sourcemap: true,
  ...hardening,
};

// The daemon itself, bundled so the vsix ships zero runtime dependencies.
// Builtins stay external (platform=node); the client script and the working
// rules file are copied next to it so /bh.py and the appended agent rules
// resolve without the repo layout.
// The win32 ACL-sandbox chain (sandboxed-shell + acl-sandbox + ffi, which
// pulls koffi) is EXTERNAL and shipped as real compiled files: the daemon
// loads it via createRequire at runtime — a dynamic require path that cannot
// resolve inside a single-file bundle (import.meta.url is undefined there,
// which used to crash every workspace tool with "filename ... undefined").
const daemonExternals = [
  // the win32 ACL-sandbox chain, shipped as real compiled files (see below):
  // sandboxed-shell → pwsh → windows-env; sandboxed-shell → acl-sandbox → ffi → koffi
  '../workspace/sandboxed-shell.js',
  '../workspace/pwsh.js',
  '../workspace/windows-env.js',
  '../win32/acl-sandbox.js',
  '../win32/ffi.js',
  'koffi',
  // daemon-owned account storage (plan 6.11): native per-platform binaries, shipped like koffi
  '@napi-rs/keyring',
];
const daemonOptions = {
  ...common,
  entryPoints: ['../../src/cli.ts'],
  define: { ...daemonBuildDefines(cloudBuild), __BLACKHOLE_INTEGRITY__: JSON.stringify(INTEGRITY_SLOT) },
  outfile: 'dist/daemon/cli.js',
  target: 'node22',
  sourcemap: false,
  external: daemonExternals,
  ...hardening,
  plugins: production ? [obfuscatePlugin] : [],
};

const supervisorOptions = {
  ...common,
  entryPoints: ['../../src/process/supervisor.cts'],
  outfile: 'dist/daemon/process-supervisor.cjs',
  target: 'node22',
  ...hardening,
};

function copyAsset(src, dest) {
  if (existsSync(src)) {
    copyFileSync(src, dest);
    console.log(`copied ${src} -> ${dest}`);
  }
}

/** Write {"type":"module"} markers BESIDE the shipped ESM externals only —
 *  never at dist/daemon/ or dist/ roots: the bundle cli.js there is CJS, and
 *  a root marker would flip it to ESM and kill the daemon at startup. The
 *  markers exist so Node does not CJS-reparse the ESM externals at require
 *  time (MODULE_TYPELESS warning + perf overhead). */
function writeModuleTypeMarkers() {
  const marker = JSON.stringify({ type: 'module' });
  for (const dir of ['dist/daemon/workspace', 'dist/daemon/win32', 'dist/workspace', 'dist/win32']) {
    writeFileSync(`${dir}/package.json`, marker);
  }
}

// The external (non-bundled) win32 sandbox chain: compiled files land at the
// exact relative path the daemon's createRequire('../workspace/sandboxed-shell.js')
// resolves to from dist/daemon/cli.js — dist/daemon/workspace/sandboxed-shell.js.
function copyDaemonExternals(rootDist) {
  const files = ['workspace/sandboxed-shell.js', 'workspace/pwsh.js', 'workspace/windows-env.js', 'win32/acl-sandbox.js', 'win32/ffi.js'];
  mkdirSync('dist/daemon/workspace', { recursive: true });
  mkdirSync('dist/daemon/win32', { recursive: true });
  // Two resolution bases coexist in the bundle:
  //  - static external requires emit "../workspace/pwsh.js" (relative to the
  //    bundle root → packages/vscode/dist/workspace/), from source files that
  //    imported pwsh directly (tools.ts etc.)
  //  - the dynamic loader uses "./workspace/sandboxed-shell.js" (relative to
  //    dist/daemon/, where __filename points in the bundled form)
  // Ship the chain at BOTH layouts so every require form resolves.
  mkdirSync('dist/workspace', { recursive: true });
  mkdirSync('dist/win32', { recursive: true });
  for (const rel of files) {
    copyAsset(`${rootDist}/${rel}`, `dist/daemon/${rel}`);
    copyAsset(`${rootDist}/${rel}`, `dist/${rel}`);
  }
  copyKoffiNodeModules();
  copyKeyringNodeModules();
}

/**
 * @napi-rs/keyring resolves its native binary from a sibling
 * @napi-rs/keyring-<target> package. Ships the loader plus every target
 * package found locally or fetched by scripts/fetch-keyring-prebuilds.mjs
 * (.cache/keyring-prebuilds). A target without a binary reports account
 * storage as unavailable instead of crashing the daemon.
 */
function copyKeyringNodeModules() {
  const loader = realpathSync('../../node_modules/@napi-rs/keyring');
  const dest = 'dist/daemon/node_modules/@napi-rs';
  rmSync(dest, { recursive: true, force: true });
  copyRealFileTree(loader, `${dest}/keyring`, isRuntimeKoffiFile);
  const found = new Map();
  const pnpmStore = join(loader, '..');
  for (const dir of [pnpmStore, join(process.cwd(), '../../.cache/keyring-prebuilds')]) {
    let names = [];
    try { names = readdirSync(dir); } catch { names = []; }
    for (const name of names) {
      const m = /^(?:@napi-rs\+)?keyring-([a-z0-9-]+?)(?:@[\d.]+)?$/.exec(name);
      if (!m || found.has(m[1])) continue;
      const pkg = existsSync(join(dir, name, 'package.json')) ? join(dir, name) : join(dir, name, 'node_modules/@napi-rs', `keyring-${m[1]}`);
      if (existsSync(join(pkg, 'package.json'))) found.set(m[1], pkg);
    }
  }
  for (const [target, pkg] of found) copyRealFileTree(pkg, `${dest}/keyring-${target}`, isRuntimeKoffiFile);
  console.log(`copied @napi-rs/keyring (${[...found.keys()].join(', ') || 'no native targets'})`);
}

/**
 * The sandbox chain's ffi.js does `import koffi from 'koffi'` — a BARE module
 * specifier. Inside the installed extension there is no ancestor
 * node_modules, so the vsix must SHIP koffi itself, beside the daemon entry:
 * dist/daemon/node_modules/koffi (the JS loader) plus
 * dist/daemon/node_modules/@koromix/koffi-win32-x64 (the native koffi.node
 * the loader discovers via its @koromix sibling convention). pnpm installs
 * these as junctions — cpSync would try to RECREATE the link (EPERM without
 * privileges on Windows), so copyRealFileTree walks and copies REAL files.
 */
function copyKoffiNodeModules() {
  const koffiRoot = resolveKoffiRealRoot();
  // koffi must live beside BOTH chain layouts: dist/daemon/node_modules serves
  // the daemon-local copies, dist/node_modules serves the outer ones
  // (dist/win32/ffi.js reached by static external requires, e.g. the proxy job
  // object) — inside the installed extension there is no ancestor
  // node_modules, so every layout needs its own walk-up base.
  for (const dest of ['dist/daemon/node_modules', 'dist/node_modules']) {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    copyRealFileTree(koffiRoot, `${dest}/koffi`, isRuntimeKoffiFile);
    // platform prebuild packages: @koromix/koffi-<os>-<arch> (the native binary)
    const scoped = join(koffiRoot, '..', '@koromix');
    let platformPkgs = [];
    try {
      platformPkgs = readdirSync(scoped).filter((name) => name.startsWith('koffi-'));
    } catch {
      platformPkgs = [];
    }
    if (platformPkgs.length > 0) {
      mkdirSync(`${dest}/@koromix`, { recursive: true });
      for (const name of platformPkgs) {
        copyRealFileTree(join(scoped, name), `${dest}/@koromix/${name}`, isRuntimeKoffiFile);
      }
    } else {
      // no scoped prebuild package (source build layout): fall back to the
      // koffi/build/koffi tree, which the loader also probes
      const buildDir = join(koffiRoot, 'build');
      if (existsSync(buildDir)) copyRealFileTree(buildDir, `${dest}/koffi/build`, isRuntimeKoffiFile);
    }
  }
  console.log('copied koffi into dist/daemon/node_modules and dist/node_modules');
}

/** Extension allowlist for the shipped koffi trees: the loader chain is
 *  index/indirect (.js/.cjs, incl. src/koffi/*.js) + native .node +
 *  package.json + LICENSE. Everything else (.cc/.hh/.S/.asm build sources,
 *  doc/, CMakeLists) is never read at require time — pruning it drops
 *  ~1.6MB and ~110 files per shipped koffi copy. */
const RUNTIME_KOFFI_EXT = new Set(['.js', '.cjs', '.mjs', '.json', '.node']);
function isRuntimeKoffiFile(name) {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && RUNTIME_KOFFI_EXT.has(name.slice(dot))) || name.startsWith('LICENSE');
}

/** Recursive copy that follows junctions/symlinks and writes REAL files
 *  (pnpm store entries contain no nested links at this depth — koffi's tree
 *  is plain files). Optional keep(name) filters FILES; dest dirs are created
 *  lazily so pruned trees leave no empty scaffolding. */
function copyRealFileTree(src, dest, keep) {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) copyRealFileTree(from, to, keep);
    else if (entry.isFile() && (keep === undefined || keep(entry.name))) {
      mkdirSync(dest, { recursive: true });
      copyFileSync(from, to);
    } else if (entry.isSymbolicLink()) {
      // resolve the link target; copy whatever it is (file or tree)
      const real = realpathSync(from);
      if (statSync(real).isDirectory()) copyRealFileTree(real, to, keep);
      else if (keep === undefined || keep(entry.name)) {
        mkdirSync(dest, { recursive: true });
        copyFileSync(real, to);
      }
    }
  }
}

/** Resolve the REAL koffi directory (through the pnpm symlink) from this package's node_modules. */
function resolveKoffiRealRoot() {
  // packages/vscode/node_modules/koffi → pnpm store real dir (walk up from here)
  const candidates = [
    'node_modules/koffi',
    '../../node_modules/koffi',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return realpathSync(c);
  }
  throw new Error('koffi not found in node_modules — run pnpm install at the workspace root first');
}

/** O2: move external source maps out of the shipped tree. */
function stashSourceMaps() {
  if (!production) return;
  rmSync(SOURCEMAP_DIR, { recursive: true, force: true });
  for (const file of ['dist/extension.js.map', 'dist/daemon/cli.js.map', 'dist/daemon/process-supervisor.cjs.map']) {
    if (!existsSync(file)) continue;
    mkdirSync(SOURCEMAP_DIR, { recursive: true });
    copyFileSync(file, join(SOURCEMAP_DIR, file.split('/').pop()));
    rmSync(file, { force: true });
  }
  if (production) console.log('source maps -> ' + SOURCEMAP_DIR);
}

/** O4: hash every shipped daemon runtime file and seal the manifest into cli.js
 *  (see src/integrity.ts; cli.js hashes itself with the slot emptied). */
function sealIntegrity() {
  const base = 'dist/daemon';
  const manifest = {};
  const walk = (rel) => {
    const abs = join(base, rel);
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(r); continue; }
      if (r === 'cli.js' || e.name === 'package.json' || !/\.(js|cjs|mjs|py|html|css|svg|png|ico|woff2?)$/.test(e.name)) continue;
      manifest[r] = createHash('sha256').update(readFileSync(join(base, r))).digest('hex');
    }
  };
  walk('');
  const cliPath = join(base, 'cli.js');
  const cli = readFileSync(cliPath, 'latin1');
  const at = cli.indexOf(INTEGRITY_SLOT);
  if (at < 0 || cli.indexOf(INTEGRITY_SLOT, at + 1) >= 0) throw new Error('integrity slot must appear exactly once in cli.js');
  // same normalization as stripIntegritySlot() at runtime: hash with the slot content removed
  manifest['cli.js'] = createHash('sha256').update(cli.slice(0, at) + '<<BHI::BHI>>' + cli.slice(at + INTEGRITY_SLOT.length)).digest('hex');
  const body = Buffer.from(JSON.stringify(manifest)).toString('base64');
  if (body.length > 8192) throw new Error('integrity manifest exceeds the reserved slot');
  const sealed = '<<BHI:' + body.padEnd(8192, ' ') + ':BHI>>';
  writeFileSync(cliPath, cli.slice(0, at) + sealed + cli.slice(at + INTEGRITY_SLOT.length), 'latin1');
  console.log('integrity sealed: ' + Object.keys(manifest).length + ' files');
}

if (watch) {
  const contexts = await Promise.all([extensionOptions, daemonOptions, supervisorOptions].map(options => esbuild.context(options)));
  await Promise.all(contexts.map(context => context.watch()));
  console.log('watching for changes...');
} else {
  await esbuild.build(extensionOptions);
  // check-webview resolves the embedded scripts by source identifier names, which minify renames;
  // the script text itself is unchanged, so production checks an unminified twin (never shipped).
  if (production) await esbuild.build({ ...extensionOptions, minify: false, keepNames: false, sourcemap: false, logLevel: 'silent', outfile: join(process.cwd(), '../../.tmp/webview-check/extension.js') });
  await esbuild.build(daemonOptions);
  await esbuild.build(supervisorOptions);
  const writeCloudBuild = () => writeFileSync('dist/cloud-build.json', JSON.stringify({ ...cloudBuild, extensionSha256: createHash('sha256').update(readFileSync('dist/extension.js')).digest('hex'), daemonSha256: createHash('sha256').update(readFileSync('dist/daemon/cli.js')).digest('hex'), processSupervisorSha256: createHash('sha256').update(readFileSync('dist/daemon/process-supervisor.cjs')).digest('hex') }, null, 2) + '\n');
  copyAsset('../../client/bh.py', 'dist/daemon/bh.py');
  // Local Web page (packages/web build) is served by the daemon from dist/daemon/web.
  rmSync('dist/daemon/web', { recursive: true, force: true });
  if (existsSync('../web/dist/index.html')) {
    cpSync('../web/dist', 'dist/daemon/web', { recursive: true });
    console.log('copied ../web/dist -> dist/daemon/web');
  } else {
    console.warn('Local Web assets missing: run `pnpm --dir packages/web build` first.');
  }
  copyDaemonExternals('../../dist');
  writeModuleTypeMarkers();
  stashSourceMaps();
  sealIntegrity();
  writeCloudBuild(); // after sealing: hashes describe the shipped cli.js
  // MIT attribution for the ported semantic-search code must travel with the bundle
  copyAsset('../../src/semantic/LICENSE-MIT', 'dist/daemon/LICENSE-MIT');
  copyAsset('../../src/semantic/NOTICE.md', 'dist/daemon/semantic-NOTICE.md');
  // The universal package uses an operator-installed tunnel connector. Always
  // clear old full-build assets, including extension prepublish rebuilds.
  for (const name of ['cloudflared.exe', 'cloudflared']) {
    rmSync(`dist/daemon/${name}`, { force: true });
  }
  console.log('Universal build: cloudflared is external (PATH or blackhole.cloudflaredPath).');
}
