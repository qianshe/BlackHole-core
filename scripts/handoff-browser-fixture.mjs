import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
import { handoffModules } from '../packages/vscode/test/handoff-modules.mjs';
const require=createRequire(import.meta.url),ts=require('typescript');
function compile(file,imports={}) {
 const module={exports:{}};
 const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{module,exports:module.exports,console,require:n=>n in imports?imports[n]:require(n)});return module.exports;
}
const icons=compile('packages/vscode/src/icons.ts');
const {SidebarProvider}=compile('packages/vscode/src/sidebar.ts',{
 ...handoffModules, './icons':icons, './toolNames':{}, './callFormat':{}, './editorNavigation':{}, './config':{getConfig:()=>({})},
 vscode:{workspace:{workspaceFolders:[]},window:{},commands:{},env:{clipboard:{}}},
});
const sub=()=>({dispose(){}}),provider=new SidebarProvider({}, {onDidChangeState:sub}, {onTick:sub}, {});
let html=provider.html();
const fixture={type:'update',mode:'sessions',sessions:[{id:'fixture',name:'非常长的测试会话名称和待审批状态',workspace_path:'D:/synthetic-fixture',status:'active',activity:'running',permission_mode:'workspace-write',pending_handoff:{id:'handoff-a',created_at:123456789}},{id:'second',name:'第二个测试会话',workspace_path:'D:/synthetic-fixture-two',status:'paused',permission_mode:'read-only',pending_handoff:{id:'handoff-b',created_at:123456790}}],pending:[],calls:[],todos:[],tunnel:null,daemon:'running',handoffSynchronized:true,handoffGeneration:0,callTotal:0,windowTotal:0,callPage:0};
const bootstrap=`<script>window.sent=[];window.fixture=${JSON.stringify(fixture)};window.acquireVsCodeApi=()=>({postMessage(m){window.sent.push(m)}});window.update=(data=window.fixture)=>window.postMessage(data,'*');window.addEventListener('load',()=>window.update());</script>`;
html=html.replace('<head>','<head>'+bootstrap);
fs.mkdirSync('_temp/design-demos',{recursive:true});
fs.writeFileSync('_temp/design-demos/handoff-production-check.html',html);
console.log('Generated production sidebar HTML with synthetic data only.');
provider.dispose();
