// Load the real shared path resolver for source-transpiled tunnel tests.
// No filesystem writes, downloads, credential-store access or installed daemon IO.
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const module = { exports: {} };
const source = fs.readFileSync(new URL('../../../src/data-paths.ts', import.meta.url), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
  { module, exports: module.exports, require, process, Buffer });
export const dataPaths = module.exports;
