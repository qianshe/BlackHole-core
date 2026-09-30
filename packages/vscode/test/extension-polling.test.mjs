import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const pause=()=>new Promise(resolve=>setImmediate(resolve));
const disposable=()=>({dispose(){}});

// Execute the real activation, Poller and SidebarProvider together, but keep
// VS Code, timers and all daemon IO in memory. No installed instance is touched.
function setup(initialOk) {
 const timers=new Set(),commands=new Map(),listeners=new Set(),messages=[],errors=[];
 const context={subscriptions:[]};
 let online=initialOk,epoch=1,activity='running',provider,ensureCalls=0,restarts=0,stops=0,stopResult=true,reads=0,accountSnapshots=0,heartbeats=0,onDaemonReady;
 const timer=(fn,ms)=>{const value={fn,ms,unrefCalled:false,unref(){this.unrefCalled=true}};timers.add(value);return value};
 const vscode={
  commands:{registerCommand(name,fn){commands.set(name,fn);return disposable()},async executeCommand(name,...args){return commands.get(name)?.(...args)}},env:{},
  ProgressLocation:{Notification:1},
  workspace:{workspaceFolders:[],onDidChangeConfiguration:disposable},
  window:{state:{focused:true},createOutputChannel:()=>({appendLine(){},dispose(){}}),
   registerWebviewViewProvider(_id,value){provider=value;return disposable()},
   withProgress:async(_options,fn)=>fn(),showErrorMessage:text=>errors.push(text)}
 };
 const check=()=>{if(!online)throw Error('daemon unavailable')};
 class Api {
  async heartbeat(){heartbeats++;check()}
  async changes(){check();return{epoch}}
  async listSessions(){reads++;check();return{sessions:[{id:'fixture',status:'active',workspace_path:'D:/fixture',activity}]}}
  async health(){check();return{tunnel:'offline'}}
  async confirmations(){check();return{confirmations:[]}}
 }
 let daemon;
 class Daemon {
  constructor(){daemon=this;this.currentState=online?'running':'error'}
  onDidChangeState(fn){listeners.add(fn);return{dispose:()=>listeners.delete(fn)}}
  async ensureRunning(){ensureCalls++;return initialOk}
  async syncConfigRestart(){return true}
  async stop(){stops++;if(stopResult){online=false;this.currentState='stopped';for(const fn of listeners)fn('stopped')}return stopResult}
  async restart(){restarts++;online=true;this.currentState='running';for(const fn of listeners)fn('running');return true}
  dispose(){listeners.clear()}
 }
 class Unused {dispose(){}}
 const mocks={vscode,'./config':{getConfig:()=>({pollIntervalMs:1000})},
  './controlApi':{ControlApi:Api},'./daemonManager':{DaemonManager:Daemon},
  './statusbar':{StatusBarController:class extends Unused {constructor(_daemon,_api,_poller,ready){super();onDaemonReady=ready;}}},'./approvals':{ApprovalsWatcher:Unused},
  './processTerminals':{ProcessTerminalController:class {start(){}show(){}stopSelected(){}stopAndCloseSelected(){}dispose(){}}},
  './cloudAccount':{registerCloudAccount:()=>{commands.set('blackhole.accountSnapshot',()=>{accountSnapshots++});return disposable()}},'./sessionActions':{},'./courierChat':{chatSend:async()=>({ok:false,message:'',sent:false})},'./configPanel':{},'./webAgents':{},'./localWeb':{},'./settingsSync':{SettingsSync:class {async sync(){}dispose(){}}},
  './icons':{sidebarIcons:()=>''},'./callFormat':{},
  './editorNavigation':{editorNavigationPreview:()=>undefined,resolveEditorNavigation:()=>({state:'file_only'})}};
 const modules=new Map();
 function load(name) {
  if(Object.hasOwn(mocks,name))return mocks[name];
  if(!['./extension','./sidebar','./poller','./toolNames','./handoffCopy','./handoffView','./templates','./callWindow','./markdown'].includes(name))return require(name);
  if(modules.has(name))return modules.get(name).exports;
  const source=fs.readFileSync(new URL(`../src/${name.slice(2)}.ts`,import.meta.url),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};modules.set(name,module);
  vm.runInNewContext(js,{module,exports:module.exports,console,AbortController,require:load,
   setInterval:timer,clearInterval:value=>timers.delete(value),setTimeout:timer,clearTimeout:value=>timers.delete(value)});
  return module.exports;
 }
 load('./extension').activate(context);
 provider.resolveWebviewView({webview:{html:'',options:{},postMessage:async message=>{messages.push(message);return true},onDidReceiveMessage:disposable},onDidDispose:disposable});
 return {
  messages,errors,async tick(){for(const value of [...timers])if(value.ms===1000)value.fn();await pause()},
  async heartbeatTick(){for(const value of [...timers])if(value.ms===10000)value.fn();await pause()},
  recover(){online=true;daemon.currentState='running';for(const fn of listeners)fn('running')},
  observeDaemon(id){onDaemonReady(id)},
  change(value){activity=value;epoch++},
  setStopResult(value){stopResult=value},
  async stop(){commands.get('blackhole.stopDaemon')();await pause()},
  async restart(){commands.get('blackhole.restartDaemon')();await pause()},
  focus(value){vscode.window.state.focused=value},
  counts:()=>({pollers:[...timers].filter(value=>value.ms===1000).length,heartbeatTimers:[...timers].filter(value=>value.ms===10000).length,heartbeatUnref:[...timers].some(value=>value.ms===10000&&value.unrefCalled),timers:timers.size,ensureCalls,restarts,stops,reads,accountSnapshots,heartbeats}),
  dispose(){for(const item of context.subscriptions)item.dispose()}
 };
}

test('initial startup failure still permits automatic refresh after recovery',async t=>{
 const h=setup(false);t.after(()=>h.dispose());await pause();
 h.recover();await h.tick();assert.equal(h.messages.at(-1).sessions[0]?.activity,'running');
 h.change('idle');await h.tick();assert.equal(h.messages.at(-1).sessions[0].activity,'idle');
 assert.equal(h.counts().ensureCalls,1);assert.equal(h.counts().restarts,0);
});
test('successful restart after initial startup failure keeps subsequent states refreshing',async t=>{
 const h=setup(false);t.after(()=>h.dispose());await pause();
 await h.restart();assert.equal(h.messages.at(-1).sessions[0]?.activity,'running');
 h.change('idle');await h.tick();assert.equal(h.messages.at(-1).sessions[0].activity,'idle');
 assert.equal(h.counts().pollers,1);
});

test('failed daemon stop is surfaced instead of ending silently',async t=>{
 const h=setup(true);t.after(()=>h.dispose());await pause();
 h.setStopResult(false);await h.stop();
 assert.equal(h.counts().stops,1);assert.match(h.errors.at(-1),/daemon 停止失败/);
});


test('daemon recovery immediately resynchronizes the entitlement bridge',async t=>{
 const h=setup(false);t.after(()=>h.dispose());await pause();
 assert.equal(h.counts().accountSnapshots,0);
 h.recover();await pause();assert.equal(h.counts().accountSnapshots,0,'a state label alone is not a daemon incarnation');
 h.observeDaemon('recovered-daemon');await pause();
 assert.equal(h.counts().accountSnapshots,1);
});

test('public-channel heartbeat remains a referenced extension-host lease',async t=>{
 const h=setup(true);t.after(()=>h.dispose());await pause();
 assert.equal(h.counts().heartbeatTimers,1);assert.equal(h.counts().heartbeatUnref,false);
 const before=h.counts().heartbeats;await h.heartbeatTick();assert.equal(h.counts().heartbeats,before+1);
});
test('missed heartbeats close the public channel but never exit a detached daemon', async () => {
 const source=fs.readFileSync(new URL('../../../src/tunnel/watchdog.ts',import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};let now=0,tick,channelStops=0,shutdowns=0,exits=0;
 vm.runInNewContext(js,{module,exports:module.exports,Date:{now:()=>now},
  setInterval:fn=>{tick=fn;return 1},clearInterval:()=>{},process:{exit:()=>{exits++}}});
 const deps={lastHeartbeatAt:0,tunnel:{status:'online',stop:async()=>{channelStops++;deps.tunnel.status='off'}},
  shutdown:async()=>{shutdowns++},log:()=>{}};
 // Exercise the legacy opt-in too: an extension lease may close a channel, not the daemon.
 const watchdog=module.exports.startChannelWatchdog(deps,true);
 now=46_000;tick();await pause();assert.equal(channelStops,1);
 now=120_000;tick();await pause();assert.equal(channelStops,1);
 assert.equal(shutdowns,0);assert.equal(exits,0);
 watchdog.stop();
});
test('successful startup and repeated restarts use one disposable poller',async()=>{
 const h=setup(true);await pause();await h.tick();
 assert.equal(h.counts().pollers,1);
 await h.restart();await h.restart();assert.equal(h.counts().pollers,1);
 h.change('idle');await h.tick();assert.equal(h.messages.at(-1).sessions[0].activity,'idle');
 const before=h.counts().reads;h.dispose();assert.equal(h.counts().timers,0);
 await h.tick();assert.equal(h.counts().reads,before);
});
test('unfocused windows retain the five-tick backoff',async t=>{
 const h=setup(true);t.after(()=>h.dispose());await pause();h.focus(false);h.change('idle');
 const before=h.counts().reads;
 for(let n=0;n<4;n++)await h.tick();assert.equal(h.counts().reads,before);
 await h.tick();assert.equal(h.messages.at(-1).sessions[0].activity,'idle');
 assert.equal(h.counts().reads,before+1);
});
