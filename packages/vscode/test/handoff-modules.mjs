// Use the production presentation and assembly modules, not behavioral stubs.
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const allowed = new Set(['./handoffCopy', './handoffView', './templates', './callWindow', './sessionFeed', './markdown']);
const cache = new Map();
function load(name) {
  if (!allowed.has(name)) return require(name);
  if (cache.has(name)) return cache.get(name).exports;
  const source = fs.readFileSync(new URL(`../src/${name.slice(2)}.ts`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} }; cache.set(name, module);
  vm.runInNewContext(js, { module, exports: module.exports, require: load, URL, URLSearchParams, console, AbortController, setTimeout, clearTimeout });
  return module.exports;
}
export const handoffModules = Object.fromEntries([...allowed].map(name => [name, load(name)]));
