import {test} from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
function controller(api = {}, onDaemonReady = () => {}) {
 const listeners = new Set();
 const item = {text:'',tooltip:undefined,show(){},dispose(){this.disposed=true}};
 class MarkdownString { constructor(value=''){this.value=value;} appendMarkdown(value){this.value+=value;return this;} appendText(value){this.value+=value;return this;} }
 const module = {exports:{}};
 const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(js,{module,exports:module.exports,require:name=>name==='vscode'?{MarkdownString,StatusBarAlignment:{Right:1},ThemeColor:class{},window:{createStatusBarItem:()=>item}}:require(name)});
 const daemon = {currentState:'running',captureHealthObservation:()=>({revision:0,port:7306}),observeHealth:()=>true,
  onDidChangeState:fn=>{listeners.add(fn);return{dispose(){listeners.delete(fn)}}}};
 const instance = new module.exports.StatusBarController(daemon,api,{onTick:()=>({dispose(){}})},onDaemonReady);
 instance.health = {version:'0.3.130',tunnel:'online',stats:{total:42,diff_added:328,diff_removed:96}};
 return {instance,item,listeners,fire(state){daemon.currentState=state;for(const fn of listeners)fn(state)}};
}
const source=readFileSync(new URL('../src/statusbar.ts',import.meta.url),'utf8');
const body=source.match(/private accountLabel\(\): string \{([\s\S]*?)\n  \}/)?.[1];assert.ok(body);
const remainingBody=source.match(/private remainingLabel\(\): string \| null \{([\s\S]*?)\n  \}/)?.[1];assert.ok(remainingBody);
const label=new Function(body),remaining=new Function(remainingBody);
const account=seconds=>({state:'verified',account:{status:'active'},remainingSeconds:seconds});

const delayed = () => { let resolve; const promise = new Promise(r => {resolve=r}); return {promise,resolve}; };
test('an old pre-restart health response cannot overwrite the new daemon snapshot', async () => {
 const old=delayed();let reads=0;const seen=[];
 const h=controller({health:()=>++reads===1?old.promise:Promise.resolve({daemon_id:'new',version:'new',tunnel:'online'})},id=>seen.push(id));
 const pending=h.instance.refreshHealth(false);
 await h.instance.refreshHealth(true);
 old.resolve({daemon_id:'old',version:'old',tunnel:'off'});await pending;
 assert.equal(h.instance.health.daemon_id,'new');assert.equal(h.instance.health.tunnel,'online');
 assert.deepEqual(seen,['new']);h.instance.dispose();
});
test('ordinary slow status polls are single-flight', async () => {
 const wait=delayed();let reads=0;const h=controller({health:()=>{reads++;return wait.promise}});
 const a=h.instance.refreshHealth(false), b=h.instance.refreshHealth(false);
 assert.equal(reads,1);wait.resolve({daemon_id:'one',tunnel:'off'});await Promise.all([a,b]);h.instance.dispose();
});
test('statusbar disposal invalidates pending reads and unregisters daemon listeners', async () => {
 const wait=delayed();const h=controller({health:()=>wait.promise});const before=h.instance.health;
 const pending=h.instance.refreshHealth(false);h.instance.dispose();
 wait.resolve({daemon_id:'late',tunnel:'online'});await pending;
 assert.equal(h.instance.health,before);assert.equal(h.listeners.size,0);
});
const format=seconds=>remaining.call({account:account(seconds)});
test('tooltip time is compact, coarse and never rounds remaining time upward',()=>{
 assert.equal(format(0),'已到期');assert.equal(format(59),'剩余不足1分钟');assert.equal(format(119),'剩余1分钟');
 assert.equal(format(5400),'剩余1小时30分');assert.equal(format(5340),'剩余1小时20分');assert.equal(format(176400),'剩余2天');
});
test('normal statusbar shows only BlackHole and puts remaining time immediately under its title',()=>{
 const {instance,item}=controller(); instance.updateAccount(account(5400));
 assert.equal(item.text,'$(link) BlackHole');
 assert.match(item.tooltip.value,/^### .*BlackHole v0\.3\.130\n\n\$\(clock\) \*\*剩余1小时30分\*\*/);
 assert.ok(!item.tooltip.value.includes('已登录'));
 const same=item.tooltip;instance.updateAccount(account(5400));assert.equal(item.tooltip,same,'unchanged polls must not replace the hover');
 instance.dispose();
});
test('unavailable restricted execution is surfaced without claiming native tools are missing',()=>{
 const {instance,item}=controller();
 instance.health={...instance.health,execution_runtime:{platform:'darwin',arch:'arm64',execution_tools:['exec','process'],exec_shell:'/bin/zsh',process_shell:'/bin/zsh',process_available:true,process_unavailable_reason:null,
  sandbox:{backend:'seatbelt',status:'unavailable',reason:'sandbox_runner_nested',detail:'sandbox_apply: Operation not permitted',fail_closed:true},
  process_management:{owner:'process-group-supervisor',cleanup_guarantee:'confirmed-or-unknown'}}};
 instance.render();assert.match(item.tooltip.value,/受限命令沙箱不可用/);assert.match(item.tooltip.value,/exec\/process 仍会显示/);assert.match(item.tooltip.value,/正常 VS Code 环境重启/);
 instance.dispose();
});
test('a missing packaged process runtime is reported separately from exec',()=>{
 const {instance,item}=controller();
 instance.health={...instance.health,execution_runtime:{platform:'darwin',arch:'arm64',execution_tools:['exec'],exec_shell:'/bin/zsh',process_shell:'/bin/zsh',process_available:false,process_unavailable_reason:'runtime_asset_missing',
  sandbox:{backend:'seatbelt',status:'available',reason:null,detail:null,fail_closed:true},process_management:{owner:'unavailable',cleanup_guarantee:'unavailable'}}};
 instance.render();assert.match(item.tooltip.value,/后台任务组件缺失/);assert.match(item.tooltip.value,/process 未注册/);assert.match(item.tooltip.value,/exec 不受/);
 instance.health.tunnel='off';instance.render();assert.equal(typeof item.tooltip,'string');assert.match(item.tooltip,/后台任务组件缺失/);
 instance.dispose();
});
test('volatile health counters do not replace an open tooltip',()=>{
 const {instance,item}=controller();instance.updateAccount(account(5400));const same=item.tooltip;
 instance.health={...instance.health,uptime_min:999,stats:{total:999,diff_added:888,diff_removed:777,rss_mb:512,heap_mb:256,mcp_initializes:99,mcp_reuses:88,mcp_rejected:77,mcp_deletes:66,mcp_live_pipes:55}};
 instance.render();assert.equal(item.tooltip,same,'diagnostic/activity polling must not rewrite the hover');
 instance.health={...instance.health,sessions_running:1};instance.render();assert.notEqual(item.tooltip,same,'material operator state may update the hover');
 instance.dispose();
});
test('running session hover never falls back to unpaused count',()=>{
 const {instance,item}=controller();
 instance.health={...instance.health,sessions_active:8,sessions_running:2};instance.render();
 assert.ok(item.tooltip.value.includes('进行中会话 **2**'));
 const same=item.tooltip;instance.health.sessions_active=9;instance.render();assert.equal(item.tooltip,same);
 instance.health.sessions_running=0;instance.render();assert.ok(item.tooltip.value.includes('进行中会话 **0**'));
 for(const value of [undefined,NaN,-1,1.5]){instance.health.sessions_running=value;instance.render();assert.ok(item.tooltip.value.includes('进行中会话 **—**'));}
 instance.dispose();
});
test('saved validated snapshot keeps a coarse countdown without rewriting an account-state suffix',()=>{
 const {instance,item}=controller(); instance.updateAccount({...account(5340),state:'saved'});
 assert.equal(item.text,'$(link) BlackHole');
 assert.match(item.tooltip.value,/剩余1小时20分/);assert.ok(!item.tooltip.value.includes('上次验证'));
 instance.updateAccount({state:'unavailable'});assert.ok(!item.tooltip.value.includes('剩余'));
 instance.updateAccount({state:'logged_out'});assert.match(item.text,/未登录/);assert.ok(!item.tooltip.value.includes('剩余'));
 instance.updateAccount(account(0));assert.match(item.text,/已到期/);instance.dispose();
});

const extensionSource=readFileSync(new URL('../src/extension.ts',import.meta.url),'utf8');
test('channel watchdog heartbeat is fixed-rate and independent from UI polling',()=>{
 assert.ok(extensionSource.includes('setInterval(heartbeat, 10_000)'));
 assert.ok(extensionSource.includes('heartbeat();'));
 assert.ok(extensionSource.includes('clearInterval(heartbeatTimer)'));
 assert.ok(!extensionSource.includes('poller.onTick(() => void api.heartbeat()'));
});
