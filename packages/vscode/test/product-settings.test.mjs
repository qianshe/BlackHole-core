import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {createRequire} from 'node:module';
import {manifestForBuild} from '../build-config.mjs';
const require=createRequire(import.meta.url),ts=require('typescript');
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
test('production ignores stored daemon overrides without reading or deleting them; test build retains them',()=>{
 const source=read('../src/config.ts'),js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 for(const environment of ['production','test']){
  const reads=[],module={exports:{}};
  vm.runInNewContext(js,{module,exports:module.exports,require:name=>name==='vscode'?{workspace:{getConfiguration:()=>({get:key=>{reads.push(key);return key==='daemonEntry'?'  custom/cli.js  ':key==='cloudflaredPath'?'tunnel.exe':undefined;}})}}:name==='./cloudEnvironment'?{resolveCloudEndpoint:()=>({environment})}:require(name)});
  const cfg=module.exports.getConfig();assert.equal(cfg.daemonEntry,environment==='test'?'custom/cli.js':'');
  assert.equal(reads.includes('daemonEntry'),environment==='test');assert.equal(cfg.cloudflaredPath,'tunnel.exe');
 }
});
test('daemon entry selection independently ignores overrides in production',()=>{
 const js=ts.transpileModule(read('../src/daemonManager.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 for(const environment of ['production','test']){
  const module={exports:{}};
  vm.runInNewContext(js,{module,exports:module.exports,process,require:name=>name==='vscode'?{}:name==='./cloudEnvironment'?{resolveCloudEndpoint:()=>({environment})}:name==='./vscodeRipgrep'?{}:require(name)});
  const entry=module.exports.DaemonManager.prototype.entryPath;
  const owner={cfg:()=>({daemonEntry:'custom/cli.js'}),context:{extensionPath:'bundled'}};
  const bundled=path.join('bundled','dist','daemon','cli.js');
  assert.equal(entry.call(owner),environment==='test'?'custom/cli.js':bundled);
  assert.equal(entry.call(owner,{daemonEntry:'captured/cli.js'}),environment==='test'?'captured/cli.js':bundled);
 }
});
test('packaging advertises daemon override only for test builds and keeps other settings intact',()=>{
 const source=JSON.parse(read('../package.json'));assert.equal(source.contributes.configuration.properties['blackhole.daemonEntry'],undefined);
 const before=JSON.stringify(source);
 for(const environment of ['production','test']){
  const manifest=manifestForBuild(source,{environment}),p=manifest.contributes.configuration.properties;
  assert.equal(Object.hasOwn(p,'blackhole.daemonEntry'),environment==='test');
  assert.deepEqual(p['blackhole.cloudflaredPath'],source.contributes.configuration.properties['blackhole.cloudflaredPath']);
 }
 assert.equal(JSON.stringify(source),before);
});
test('Cloud API environment is not a user-editable product setting', () => {
  const properties = JSON.parse(read('../package.json')).contributes.configuration.properties;
  assert.equal(properties['blackhole.cloudEnvironment'], undefined);
  assert.equal(properties['blackhole.cloudTestOrigin'], undefined);
  const panel = read('../src/configPanel.ts');
  assert.doesNotMatch(panel, /key: 'cloudEnvironment'|key: 'cloudTestOrigin'|values\.cloudEnvironment|values\.cloudTestOrigin/);
  assert.doesNotMatch(read('../src/cloudAccount.ts'), /config\.get\('cloudEnvironment'\)|config\.get\('cloudTestOrigin'\)/);
});
test('tool cards omit the initial badge without shrinking the hit area or losing content', () => {
  const source = read('../src/sidebar.ts');
  assert.doesNotMatch(source, /tool-g/);
  assert.match(source, /\.call-hd\s*\{[^}]*min-height:\s*22px/); // compact one-line tool rows in the chat timeline
  for (const cls of ['tool','sum','badge','meta','cx','body']) assert.ok(source.includes('class="'+cls+'"'));
});
test('card creation has no removed-icon dereference and retains literal tool text', () => {
  const source=read('../src/sidebar.ts');
  const code=source.match(/    function createCard\(c\) \{[\s\S]*?\n    \}/)?.[0];assert.ok(code);
  let tool;
  const create=vm.runInNewContext('('+code.trim()+')',{document:{createElement(){return {dataset:{},innerHTML:'',querySelector(selector){assert.equal(selector,'.tool');tool={};return tool;}};}}});
  const card=create({id:'fixture',tool:'<unsafe-name>'});
  assert.equal(tool.textContent,'<unsafe-name>');assert.equal(card.innerHTML.includes('tool-g'),false);
  assert.ok(card.innerHTML.includes('tabindex="0"'));assert.ok(card.innerHTML.includes('aria-expanded="false"'));
});
test('keyboard header expansion and nested cancel remain separate actions', () => {
  const source=read('../src/sidebar.ts'),handlers={};
  const keyStart=source.indexOf("    document.addEventListener('keydown', (e) => {\n      // Only the header");
  const keyEnd=source.indexOf('\n    });',keyStart)+8;
  const clickStart=source.indexOf("    document.addEventListener('click', (e) => {",source.indexOf('// 卡片交互全部事件委托'));
  const clickEnd=source.indexOf('\n    });',clickStart)+8;
  assert.ok(keyStart>=0&&clickStart>=0);
  const classes=new Set(),attributes={},openCalls=new Set(),messages=[];
  const card={dataset:{id:'c1'},classList:{contains:k=>classes.has(k),toggle:k=>classes.has(k)?classes.delete(k):classes.add(k)},querySelector:()=>({textContent:''})};
  const header={classList:{contains:k=>k==='call-hd'},closest:s=>s==='.call'?card:null,setAttribute:(k,v)=>attributes[k]=v};
  const target={classList:header.classList,closest:s=>s==='.call-hd'?header:null,click:()=>handlers.click({target})};
  const cx={classList:{contains:k=>k==='cx'},closest:s=>s==='.cx'?cx:s==='.call'?card:null};
  vm.runInNewContext(source.slice(keyStart,keyEnd)+'\n'+source.slice(clickStart,clickEnd),{
    document:{addEventListener:(name,fn)=>handlers[name]=fn},openCalls,callIndex:new Map(),vs:{postMessage:m=>messages.push(m)},curSessionId:'session-fixture',
  });
  let prevented=0;handlers.keydown({key:'Enter',target,preventDefault(){prevented++;}});
  assert.equal(attributes['aria-expanded'],'true');assert.ok(openCalls.has('c1'));
  handlers.keydown({key:' ',target,preventDefault(){prevented++;}});
  assert.equal(attributes['aria-expanded'],'false');assert.equal(openCalls.size,0);assert.equal(prevented,2);
  handlers.keydown({key:'Enter',target:cx,preventDefault(){assert.fail('native cancel key must not be intercepted');}});
  handlers.click({target:cx});assert.equal(messages[0].type,'cancel');assert.equal(classes.has('open'),false);
});
