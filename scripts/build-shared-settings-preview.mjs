// Build checked-in browser fixtures from the two real production settings entries.
// Only local files + synthetic services; no daemon, credentials, or external requests.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSettingsPreview } from './fixtures/shared-settings-browser.mjs';
import { auditSettingsControls } from './fixtures/settings-controls-audit.mjs';
import { DEFAULT_SETTINGS } from '../dist/settings/store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.tmp', 'shared-settings-preview');
fs.mkdirSync(output, { recursive: true });
const require = createRequire(path.join(root, 'packages/vscode/package.json'));
const esbuild = require('esbuild');
await esbuild.build({
  entryPoints: [path.join(root, 'packages/web/test/fixtures/shared-settings-web-preview.tsx')],
  outfile: path.join(output, 'web.js'),
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
for (const asset of ['settings.js', 'settings.css']) {
  fs.copyFileSync(path.join(root, 'packages/vscode/dist/settings', asset),
    path.join(output, asset === 'settings.js' ? 'native.js' : 'native.css'));
}
const init = `window.__model=(${createSettingsPreview.toString()})(${JSON.stringify(DEFAULT_SETTINGS).replaceAll('<', '\\u003c')}, {controls:true});window.__auditControls=(${auditSettingsControls.toString()});`;
const bridge = `let state={};window.acquireVsCodeApi=()=>({getState:()=>state,setState:s=>{state=s},postMessage:m=>{if(m.type==='settings:ready')setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'settings:init',clientId:m.clientId,page:'home',collapsed:false}})),0);if(m.type==='settings:request')window.__model.run(m.request.method,m.request.path,m.request.body).then(value=>window.dispatchEvent(new MessageEvent('message',{data:{type:'settings:reply',reply:{id:m.request.id,ok:true,value}}})),error=>window.dispatchEvent(new MessageEvent('message',{data:{type:'settings:reply',reply:{id:m.request.id,ok:false,error:{status:error.status||500,code:error.message}}}})))}});`;
const theme = `:root{color-scheme:dark;--vscode-font-family:system-ui;--vscode-editor-font-family:Consolas,monospace;--vscode-foreground:#ccc;--vscode-descriptionForeground:#9d9d9d;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#252526;--vscode-panel-border:#3c3c3c;--vscode-widget-border:#454545;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#f0f0f0;--vscode-input-border:#555;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#ccc;--vscode-focusBorder:#007fd4;--vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#fff;--vscode-list-hoverBackground:#2a2d2e;--vscode-disabledForeground:#777}`;
for (const host of ['web', 'native']) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared settings ${host} synthetic fixture</title><link rel="stylesheet" href="${host}.css"><style>${theme}</style></head><body class="${host === 'native' ? 'settings-native-host vscode-dark' : ''}"><div id="root"></div><script>${init}${host === 'native' ? bridge : ''}</script><script src="${host}.js"></script></body></html>`;
  fs.writeFileSync(path.join(output, host + '.html'), html);
  console.log(host + ': ' + pathToFileURL(path.join(output, host + '.html')).href);
}
