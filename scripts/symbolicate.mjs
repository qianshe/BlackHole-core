#!/usr/bin/env node
// Map a production stack trace back to source (plan 6.14 O2/O5).
// Production packages ship no source maps; esbuild.mjs keeps them in
// .tmp/sourcemaps/<version>/. Usage:
//   node scripts/symbolicate.mjs <version> [stack.txt]   (stdin when no file)
// Frames like ".../dist/daemon/cli.js:1:23456" or "extension.js:1:99" are rewritten.
import fs from 'node:fs';
import path from 'node:path';
import { SourceMap } from 'node:module';

const [version, file] = process.argv.slice(2);
if (!version) {
  console.error('usage: node scripts/symbolicate.mjs <version> [stack.txt]');
  process.exit(2);
}
const dir = path.resolve(import.meta.dirname, '..', '.tmp', 'sourcemaps', version);
const maps = new Map();
function mapFor(name) {
  if (!maps.has(name)) {
    const p = path.join(dir, name + '.map');
    maps.set(name, fs.existsSync(p) ? new SourceMap(JSON.parse(fs.readFileSync(p, 'utf8'))) : null);
  }
  return maps.get(name);
}

export function symbolicate(text) {
  return text.replace(/([^\s()]*?(extension\.js|cli\.js|process-supervisor\.cjs)):(\d+):(\d+)/g, (all, _p, name, line, col) => {
    const map = mapFor(name);
    const e = map?.findEntry(Number(line) - 1, Number(col) - 1);
    if (!e || !e.originalSource) return all;
    const src = e.originalSource.replace(/^.*?(?=src[\\/]|packages[\\/])/, '');
    return `${src}:${e.originalLine + 1}:${e.originalColumn + 1}${e.name ? ` (${e.name})` : ''}`;
  });
}

const input = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
if (!fs.existsSync(dir)) console.error(`no source maps for ${version} in ${dir}`);
process.stdout.write(symbolicate(input));
