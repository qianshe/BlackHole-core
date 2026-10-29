import test from 'node:test';
import { handoffModules } from './handoff-modules.mjs';
import { toolNames } from '../../../scripts/fixtures/tool-names.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');

function loadTs(url, mocks = {}) {
  const source = fs.readFileSync(url, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, console, AbortController, require: (name) => name in handoffModules ? handoffModules[name] : name === './config' ? { getConfig: () => ({}) } : name === './toolNames' ? toolNames : name in mocks ? mocks[name] : require(name), setTimeout, clearTimeout, setInterval, clearInterval });
  return module.exports;
}
const navigation = loadTs(new URL('../src/editorNavigation.ts', import.meta.url));

class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
class Selection extends Range {}
const Uri = { file: (fsPath) => ({ fsPath }) };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-sidebar-nav-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  const target = path.join(root, 'src', 'a.ts');
  fs.writeFileSync(target, 'one\ntwo\nthree\n');
  const opened = [], editors = [], errors = [], infos = [], statuses = [];
  const vscode = {
    commands: { executeCommand: async () => {} }, env: {}, Uri, Position, Range, Selection, TextEditorRevealType: { InCenter: 2 },
    workspace: {
      workspaceFolders: [],
      openTextDocument: async (uri) => {
        opened.push(uri.fsPath);
        const text = fs.readFileSync(uri.fsPath, 'utf8'), lines = text.replace(/\r\n/g, '\n').split('\n');
        if (lines.at(-1) === '') lines.pop();
        return { getText: () => text, lineCount: Math.max(1, lines.length), lineAt: (i) => ({ range: { end: new Position(i, (lines[i] || '').length) } }) };
      },
    },
    window: {
      showErrorMessage: (value) => errors.push(value), showInformationMessage: (value) => infos.push(value),
      setStatusBarMessage: (value) => statuses.push(value),
      showTextDocument: async () => { const editor = { selection: undefined, revealRange(range) { this.revealed = range; } }; editors.push(editor); return editor; },
    },
  };
  const SidebarProvider = loadTs(new URL('../src/sidebar.ts', import.meta.url), {
    vscode,
    './icons': { sidebarIcons: () => '{}' },
    './callFormat': { commandSummary: () => 'view src/a.ts', argumentDetails: () => 'details', resultBody: () => 'body', resultDiff: () => null, pendingConfirmationFor: () => undefined },
    './editorNavigation': navigation,
  }).SidebarProvider;
  const subscribe = () => ({ dispose() {} });
  const provider = new SidebarProvider({}, { currentState: 'running', onDidChangeState: subscribe }, { onTick: subscribe }, {});
  provider.mode = 'calls'; provider.selectedId = 'session';
  provider.sessions = [{ id: 'session', workspace_path: root, status: 'active' }];
  return { root, target, provider, opened, editors, errors, infos, statuses };
}

const call = (content, overrides = {}) => ({
  id: 'call', session_id: 'session', tool: 'editor', args_hash: 'hash', status: 'completed',
  args_json: JSON.stringify({ path: 'src/a.ts', operation: { command: 'str_replace', old_text: 'two', new_text: 'two' } }),
  result_summary: null,
  navigation_json: JSON.stringify({ version: 1, kind: 'str_replace', path: 'src/a.ts', startLine: 2, endLine: 2, afterSha256: navigation.sha256Text(content) }),
  created_at: 1, updated_at: 2, ...overrides,
});

test('mixed historical/new rows display editor and both navigate without mutating audit identities', async (t) => {
  const h = fixture(t), content = fs.readFileSync(h.target, 'utf8'), messages = [];
  const old = call(content, { id: 'old', tool: toolNames.LEGACY_WORKSPACE_FILE_TOOL });
  const current = call(content, { id: 'new' });
  h.provider.pageCalls = [old, current];
  h.provider.view = { webview: { postMessage: async message => { messages.push(message); return true; } } };
  h.provider.postUpdate(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(messages.at(-1).calls, row => row.tool), ['editor', 'editor']);
  await h.provider.openCallResource('old'); await h.provider.openCallResource('new');
  assert.equal(h.opened.length, 2); assert.equal(h.errors.length, 0);
  assert.equal(old.tool, toolNames.LEGACY_WORKSPACE_FILE_TOOL);
});

test('callId navigation opens the session file and selects the recorded range', async (t) => {
  const h = fixture(t), row = call(fs.readFileSync(h.target, 'utf8'));
  h.provider.pageCalls = [row];
  await h.provider.openCallResource(row.id);
  assert.deepEqual(h.opened, [fs.realpathSync(h.target)]);
  assert.equal(h.editors[0].selection.start.line, 1);
  assert.equal(h.editors[0].selection.end.line, 1);
  assert.deepEqual(h.errors, []);
});

test('navigation rejects cross-session and outside-workspace records', async (t) => {
  const h = fixture(t), content = fs.readFileSync(h.target, 'utf8');
  h.provider.pageCalls = [call(content, { session_id: 'other' })];
  await h.provider.openCallResource('call');
  assert.equal(h.opened.length, 0); assert.equal(h.errors.length, 1);
  h.errors.length = 0;
  h.provider.pageCalls = [call(content, { navigation_json: JSON.stringify({ version: 1, kind: 'str_replace', path: '../outside.ts' }) })];
  await h.provider.openCallResource('call');
  assert.equal(h.opened.length, 0); assert.equal(h.errors.length, 1);
});


test('legacy absolute paths are accepted only when they still belong to the session workspace', async (t) => {
  const h = fixture(t), inside = call('', {
    navigation_json: null,
    args_json: JSON.stringify({ path: h.target, operation: { command: 'insert', line: 0, content: 'one' } }),
  });
  h.provider.pageCalls = [inside];
  await h.provider.openCallResource('call');
  assert.deepEqual(h.opened, [fs.realpathSync(h.target)]);

  const outside = path.join(path.dirname(h.root), 'outside.ts');
  fs.writeFileSync(outside, 'outside'); t.after(() => fs.rmSync(outside, { force: true }));
  h.opened.length = 0; h.errors.length = 0;
  h.provider.pageCalls = [call('', { navigation_json: null, args_json: JSON.stringify({ path: outside, operation: { command: 'insert', line: 0, content: 'outside' } }) })];
  await h.provider.openCallResource('call');
  assert.equal(h.opened.length, 0); assert.equal(h.errors.length, 1);
});
test('webview payload omits raw call JSON and sends only the bounded navigation hint', async (t) => {
  const h = fixture(t), row = call(fs.readFileSync(h.target, 'utf8')), messages = [];
  h.provider.pageCalls = [row];
  h.provider.view = { webview: { postMessage: async (message) => { messages.push(message); return true; } } };
  h.provider.postUpdate(); await new Promise((resolve) => setImmediate(resolve));
  const shown = messages.at(-1).calls[0];
  assert.equal('args_json' in shown, false); assert.equal('result_summary' in shown, false); assert.equal('navigation_json' in shown, false);
  assert.equal('args_hash' in shown, false); assert.equal('session_id' in shown, false); assert.equal('seq' in shown, false);
  assert.equal(shown.navigation.path, 'src/a.ts'); assert.equal(shown.navigation.enabled, true);
  assert.equal('afterSha256' in shown.navigation, false); assert.equal('beforeSha256' in shown.navigation, false);
});

test('embedded call cards link only the path, keep command inert, and use one tooltip source', () => {
  const source = fs.readFileSync(new URL('../src/sidebar.ts', import.meta.url), 'utf8');
  assert.match(source, /<span class=\"resource-kind\"><\/span><button class=\"resource\" type=\"button\">/);
  assert.doesNotMatch(source, /resource-sep/);
  assert.doesNotMatch(source, /<button class=\"badge nav\"/);
  assert.match(source, /type: 'openCallResource'/);
  assert.match(source, /vs\.postMessage\(\{ type: 'openCallResource', id: card\.dataset\.id \}\)/);
  assert.match(source, /resourceEl\.setAttribute\('aria-label'/);
  assert.doesNotMatch(source, /resourceEl\.title = navigation\.ariaLabel/);
  assert.match(source, /closest\('\.sum'\)/, 'custom hover tooltip remains only on non-link summaries');
  assert.ok(source.indexOf("const resource = cl('.resource')") < source.indexOf("const hd = cl('.call-hd')"));
  assert.match(source, /callIndex\.clear\(\)/);
  assert.match(source, /callIndex\.delete\(id\)/);
});
