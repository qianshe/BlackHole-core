// Local UI fixture; renders the real settings template without an extension host or credentials.
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import {createRequire} from 'node:module';
const req=createRequire(new URL('../packages/vscode/package.json',import.meta.url));
const ts=req('typescript');
const source=fs.readFileSync(new URL('../packages/vscode/src/configPanel.ts',import.meta.url),'utf8');
const module={exports:{}};
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(js,{module,exports:module.exports,require:n=>n==='vscode'?{}:n==='./webAgents'?{AGENTS:[]}:n==='./proxySync'?{}:req(n),console});
let html=module.exports.ConfigPanel.prototype.html.call({});
const nonce=html.match(/<script nonce="([^"]+)"/)[1];
const fixture=`
window.__messages=[];
const midnight=new Date();midnight.setHours(0,0,0,0);
window.__overview={daemon:'running',version:'0.3.130',daemon_id:'fixture-only',tunnel:'online',tunnel_mode:'named',mcp_url:'',stats:{total:42,diff_added:328,diff_removed:96},activity_days:Array.from({length:7},(_,i)=>{const d=new Date(midnight);d.setDate(d.getDate()-6+i);return{start:d.getTime(),total:[0,4,12,6,88,120,42][i],diff_added:i*15,diff_removed:i*3}})};
window.__proxies={configured:true,daemonId:'fixture-only',surfaceGen:1,disabled:['disabled-fixture'],config:[{name:'local-fixture',transport:'stdio',command:'node',args:['fixture.mjs'],surface:{},warnings:[]},{name:'disabled-fixture',enabled:false,surface:{}}],status:[{name:'local-fixture',status:'offline',tools:[]},{name:'disabled-fixture',status:'disabled',tools:[]}]};
window.__send=(type,rest)=>window.dispatchEvent(new MessageEvent('message',{data:{type,...rest}}));
window.acquireVsCodeApi=()=>({postMessage:m=>{window.__messages.push(m);if(m.type==='ready')queueMicrotask(()=>{window.__send('init',{values:{},semanticMode:'off',agents:[],webAgents:[],custom:[],overview:window.__overview});window.__send('proxies',{info:window.__proxies});window.__send('cloudAccount',{view:{state:'logged_out'}});});if(m.type==='proxiesTools')queueMicrotask(()=>window.__send('proxiesToolsResult',{server:m.server,ok:true,result:{tools:[{name:'read_file',upstreamTool:'read_file',description:'Read a file',callable:true},{name:'write_file',upstreamTool:'write_file',description:'Write a file',callable:true}],cachedOnly:false}}));if(m.type==='proxiesEdit')queueMicrotask(()=>window.__send('proxiesEditResult',{server:m.server,fields:m.fields,ok:true}));},getState:()=>null,setState:()=>{}});
`;
const theme=`:root{--vscode-font-family:'Segoe UI',sans-serif;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-panel-border:#383838;--vscode-widget-border:#454545;--vscode-focusBorder:#007fd4;--vscode-charts-green:#89d185;--vscode-charts-blue:#75beff;--vscode-charts-yellow:#cca700;--vscode-errorForeground:#f48771;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#333;--vscode-button-secondaryForeground:#ccc;--vscode-input-background:#313131;--vscode-input-foreground:#ccc;--vscode-input-border:#454545;--vscode-editor-font-family:Consolas,monospace;--vscode-editorHoverWidget-background:#252526}`;
html=html.replace('</head>',`<style>${theme}</style><script nonce="${nonce}">${fixture}</script></head>`);
http.createServer((request,response)=>{if(request.url!=='/settings'){response.writeHead(404).end();return}response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});response.end(html)}).listen(4174,'127.0.0.1',()=>console.log('UI fixture: http://127.0.0.1:4174/settings'));
