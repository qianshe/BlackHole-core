import test from 'node:test';
import { toolNames } from '../../../scripts/fixtures/tool-names.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const source = fs.readFileSync(new URL('../src/editorNavigation.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(js, { module: mod, exports: mod.exports, require: name => name === './toolNames' ? toolNames : require(name), console });
const { editorNavigationPreview, resolveEditorNavigation, sha256Text } = mod.exports;
const call = (overrides = {}) => ({
  id: 'call_1', session_id: 'session', tool: 'editor', args_hash: 'hash',
  args_json: JSON.stringify({ path: 'src/a.ts', operation: { command: 'str_replace', old_text: 'old', new_text: 'new' } }),
  status: 'completed', result_summary: null, navigation_json: null, created_at: 1, updated_at: 2,
  ...overrides,
});
const navigation = (extra = {}) => JSON.stringify({ version: 1, kind: 'str_replace', path: 'src/a.ts', startLine: 2, endLine: 2, ...extra });

test('historical tool names retain exact and relocated navigation while views stay non-navigable', () => {
  const content = 'one\nnew\nthree\n';
  const current = call({ navigation_json: navigation({ afterSha256: sha256Text(content) }) });
  const historical = { ...current, tool: toolNames.LEGACY_WORKSPACE_FILE_TOOL };
  assert.deepEqual({ ...editorNavigationPreview(historical) }, { ...editorNavigationPreview(current) });
  assert.equal(resolveEditorNavigation(historical, content).state, 'exact');
  assert.equal(resolveEditorNavigation(historical, 'prefix\n' + content).state, 'relocated');
  assert.equal(editorNavigationPreview({ ...historical, navigation_json: null, args_json: JSON.stringify({ path: 'src/a.ts', operation: { command: 'view' } }) }), undefined);
  assert.equal(editorNavigationPreview({ ...current, tool: 'proxy/editor' }), undefined);
});

test('unchanged files use exact recorded ranges', () => {
  const content = 'one\nnew\nthree\n', row = call({ navigation_json: navigation({ afterSha256: sha256Text(content) }) });
  assert.deepEqual({ ...resolveEditorNavigation(row, content) }, { state: 'exact', startLine: 2, endLine: 2 });
  const preview = editorNavigationPreview(row);
  assert.equal(preview.label, 'src/a.ts · L2');
  assert.equal(preview.enabled, true);
});

test('changed files relocate unique inserted/replaced content and fail honestly on ambiguity', () => {
  const row = call({ navigation_json: navigation({ afterSha256: 'a'.repeat(64) }) });
  assert.equal(resolveEditorNavigation(row, 'prefix\nnew\nsuffix').state, 'relocated');
  assert.equal(resolveEditorNavigation(row, 'new\nother\nnew').state, 'file_only');
});

test('failed and unknown calls never claim an edit was located', () => {
  const stored = navigation({ afterSha256: sha256Text('new') });
  assert.equal(resolveEditorNavigation(call({ status: 'failed', navigation_json: stored }), 'new').state, 'file_only');
  assert.equal(resolveEditorNavigation(call({ status: 'unknown', navigation_json: stored }), 'new').state, 'file_only');
});

test('insert relocation uses the same newline normalization as editor', () => {
  const row = call({
    args_json: JSON.stringify({ path: 'src/a.ts', operation: { command: 'insert', line: 1, content: 'alpha\r\nbeta\r\n' } }),
    navigation_json: JSON.stringify({ version: 1, kind: 'insert', path: 'src/a.ts', startLine: 2, endLine: 3, afterSha256: 'a'.repeat(64) }),
  });
  const resolved = resolveEditorNavigation(row, 'prefix\nalpha\nbeta\nsuffix');
  assert.equal(resolved.state, 'relocated'); assert.equal(resolved.startLine, 2); assert.equal(resolved.endLine, 3);
});

test('view calls never expose file-open navigation, including legacy records', () => {
  const legacyView = call({ args_json: JSON.stringify({ path: 'src/a.ts', operation: { command: 'view', view_range: [4, 8] } }) });
  const storedView = call({ navigation_json: JSON.stringify({ version: 1, kind: 'view', path: 'src/a.ts', startLine: 4, endLine: 8 }) });
  assert.equal(editorNavigationPreview(legacyView), undefined);
  assert.equal(editorNavigationPreview(storedView), undefined);
});

test('delete and missing paths are distinguished', () => {
  const deleted = call({ args_json: JSON.stringify({ path: 'src/a.ts', operation: { command: 'delete' } }), navigation_json: JSON.stringify({ version: 1, kind: 'delete', path: 'src/a.ts', deleted: true }) });
  assert.equal(resolveEditorNavigation(deleted, null).state, 'deleted');
  assert.equal(resolveEditorNavigation(call({ navigation_json: navigation() }), null).state, 'missing');
  assert.equal(resolveEditorNavigation(deleted, 'recreated').state, 'file_only');
});

test('a failed legacy delete never claims that the call deleted the file', () => {
  const failedDelete = call({
    status: 'failed', navigation_json: null,
    args_json: JSON.stringify({ path: 'src/a.ts', operation: { command: 'delete' } }),
  });
  assert.equal(editorNavigationPreview(failedDelete).deleted, undefined);
  assert.equal(resolveEditorNavigation(failedDelete, null).state, 'missing');
});

test('legacy directory views do not expose a misleading file-open action', () => {
  const directory = call({
    args_json: JSON.stringify({ path: '.', operation: { command: 'view' } }),
    result_summary: JSON.stringify({ result: { message: 'Directory: C:\\workspace\nfile.ts', isError: false } }),
    navigation_json: null,
  });
  assert.equal(editorNavigationPreview(directory), undefined);
});

test('in-flight, denied, directory and non-editor calls do not expose navigation actions', () => {
  assert.equal(editorNavigationPreview(call({ status: 'started', navigation_json: navigation() })).enabled, false);
  assert.equal(editorNavigationPreview(call({ status: 'denied', navigation_json: navigation() })).enabled, false);
  assert.equal(editorNavigationPreview(call({ navigation_json: JSON.stringify({ version: 1, kind: 'view', path: '.', directory: true }) })), undefined);
  assert.equal(editorNavigationPreview(call({ tool: 'exec' })), undefined);
});
