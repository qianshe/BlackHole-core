// Render the production SidebarProvider HTML with a synthetic VS Code host.
// No account requests, installers, tunnels or workspace operations are executed.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { handoffModules } from '../packages/vscode/test/handoff-modules.mjs';
import { toolNames } from './fixtures/tool-names.mjs';
const require = createRequire(import.meta.url), ts = require('typescript');
const root = fileURLToPath(new URL('../', import.meta.url));
function loadSource(file, imports = require) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: imports, console, AbortController, setTimeout, clearTimeout, __dirname: path.join(root, 'packages/vscode/dist') });
  return module.exports;
}
const icons = loadSource('packages/vscode/src/icons.ts');
const vscode = { commands: { executeCommand: async () => {} }, env: { clipboard: { writeText: async () => {} } }, workspace: { workspaceFolders: [] }, window: { showErrorMessage() {}, showInformationMessage() {} } };
const imports = n => n in handoffModules ? handoffModules[n] : n === 'vscode' ? vscode : n === './config' ? { getConfig: () => ({}) } : n === './icons' ? icons : n === './toolNames' ? toolNames : n === './callFormat' ? {} : n === './editorNavigation' ? {} : require(n);
const { SidebarProvider } = loadSource('packages/vscode/src/sidebar.ts', imports);
const channel = { on: false, state: 'off', running: [], next: 'quick', last: null, missing: 'cloudflared', reason: null };
const api = { changes: async () => ({ epoch: 1 }), listSessions: async () => ({ sessions: [] }), health: async () => ({ tunnel: 'off' }), confirmations: async () => ({ confirmations: [] }), channel: async () => channel };
const daemon = { currentState: 'running', onDidChangeState: () => ({ dispose() {} }) };
const provider = new SidebarProvider(api, daemon, { onTick: () => ({ dispose() {} }) }, { setupDismissed: () => false });
const messages = [];
const webview = { html: '', options: {}, postMessage: async m => { messages.push(m); return true; }, onDidReceiveMessage: () => ({ dispose() {} }) };
provider.resolveWebviewView({ webview, onDidDispose: () => ({ dispose() {} }) });
await new Promise(resolve => setImmediate(resolve));
await provider.refresh(true);
const base = messages.filter(m => m.type === 'update').at(-1);
provider.dispose();
const theme = `:root { --vscode-font-family: 'Segoe UI','Microsoft YaHei',sans-serif; --vscode-editor-font-family: Consolas,monospace; --vscode-foreground:#cccccc; --vscode-descriptionForeground:#a0a0a0; --vscode-sideBar-background:#181818; --vscode-panel-border:#303030; --vscode-button-background:#0078d4; --vscode-button-foreground:#ffffff; --vscode-button-hoverBackground:#026ec1; --vscode-textLink-foreground:#64b3f4; --vscode-focusBorder:#59aaf2; --vscode-editorWidget-background:#202020; --vscode-textCodeBlock-background:#222222; --vscode-charts-green:#89c79b; --vscode-charts-yellow:#d6bc74; --vscode-charts-red:#f09b8f; --vscode-errorForeground:#f09b8f; --vscode-icon-foreground:#cccccc; --vscode-toolbar-hoverBackground:#2b2b2b; --vscode-list-hoverBackground:#252525; --vscode-progressBar-background:#64b3f4; } body { background:var(--vscode-sideBar-background); }`;
const shim = `window.__previewMessages=[]; window.__previewErrors=[]; window.addEventListener('error', e=>window.__previewErrors.push(e.message)); window.__fixture=${JSON.stringify(base).replace(/</g, '\\u003c')}; function acquireVsCodeApi(){return {postMessage:m=>window.__previewMessages.push(m), getState:()=>null,setState:()=>{}};} window.__setPreview=patch=>{window.postMessage({...structuredClone(window.__fixture),...patch},'*');};`;
const html = webview.html.replace('<head>', '<head><title>BlackHole B — production HTML / synthetic host</title>').replace('</style>', theme + '\n</style>').replace('const vs = acquireVsCodeApi();', shim + '\nconst vs = acquireVsCodeApi();');
const out = path.join(root, '.tmp/sidebar-onboarding-b.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html, 'utf8');
console.log(JSON.stringify({ file: out, bytes: Buffer.byteLength(html), mockHost: true }));
