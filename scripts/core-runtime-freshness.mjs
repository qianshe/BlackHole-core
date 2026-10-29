import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// The native Core layout reuses the VS Code daemon bundle, not root dist/cli.js.
// A new buildId and archive signature do not prove that bundle is current.
// These local build receipts prevent an old bundle from silently being packaged.
export const CORE_INPUTS = [
  'src', 'packages/contracts/src', 'client/bh.py',
  'package.json', 'pnpm-lock.yaml', 'tsconfig.json',
  'packages/vscode/esbuild.mjs', 'packages/vscode/build-config.mjs',
  'scripts/core-runtime-freshness.mjs',
];
export const BUNDLE_OUTPUTS = [
  'packages/vscode/dist/daemon', 'packages/vscode/dist/workspace',
  'packages/vscode/dist/win32', 'packages/vscode/dist/node_modules',
];
export const RECEIPT_PATH = 'packages/vscode/dist/core-runtime-build.json';
const WEB_SOURCE = 'packages/web/dist';
const WEB_COPY = 'packages/vscode/dist/daemon/web';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rebuild = 'Rebuild Core, Web and the VS Code daemon bundle before assembling the runtime.';

/** Sorted relative paths and byte hashes, not timestamps or machine paths. */
export function hashBuildTree(root, entries) {
  const result = {};
  const visit = relative => {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) throw new Error(`build_output_missing:${relative}`);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`build_symlink_not_allowed:${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(relative ? relative + '/' + name : name);
    } else if (stat.isFile()) {
      result[relative] = sha256(fs.readFileSync(absolute));
    } else {
      throw new Error(`build_file_type_invalid:${relative}`);
    }
  };
  for (const entry of [...entries].sort()) visit(entry);
  return result;
}

export function captureCoreBuildInputs(root) {
  return {
    source: hashBuildTree(root, CORE_INPUTS),
    web: hashBuildTree(path.join(root, WEB_SOURCE), ['']),
  };
}

function assertWebCopy(root, expected) {
  const copy = hashBuildTree(path.join(root, WEB_COPY), ['']);
  if (!same(expected, copy)) throw new Error(`stale_web_assets:VS Code daemon Web copy differs from packages/web/dist. ${rebuild}`);
}

/** Called after bundling/sealing and copying assets, never by the assembler. */
export function recordCoreBundleBuild(root, inputs) {
  const current = captureCoreBuildInputs(root);
  if (!same(inputs, current)) throw new Error(`build_inputs_changed_during_bundle. ${rebuild}`);
  assertWebCopy(root, inputs.web);
  const receipt = { formatVersion: 1, inputs, outputs: hashBuildTree(root, BUNDLE_OUTPUTS) };
  fs.writeFileSync(path.join(root, RECEIPT_PATH), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

/** Must run before creating an output layout or signing any candidate. */
export function verifyCoreBundleFreshness(root) {
  const current = captureCoreBuildInputs(root);
  assertWebCopy(root, current.web);
  const file = path.join(root, RECEIPT_PATH);
  if (!fs.existsSync(file)) throw new Error(`stale_core_bundle:missing build receipt. ${rebuild}`);
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`stale_core_bundle:invalid build receipt. ${rebuild}`); }
  if (receipt.formatVersion !== 1 || !same(receipt.inputs, current)) {
    throw new Error(`stale_core_bundle:inputs changed since the VS Code daemon was bundled. ${rebuild}`);
  }
  const outputs = hashBuildTree(root, BUNDLE_OUTPUTS);
  if (!same(receipt.outputs, outputs)) throw new Error(`stale_core_bundle:bundled outputs changed. ${rebuild}`);
  return {
    sourceHash: sha256(JSON.stringify(current.source)),
    webHash: sha256(JSON.stringify(current.web)),
    bundleHash: sha256(JSON.stringify(outputs)),
  };
}
