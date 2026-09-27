import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import type {PermissionMode} from '../config.js';
import { windowsEnvValue, windowsExecutionPath } from './windows-env.js';

/** File-write confinement, not a confidentiality or network sandbox. */
export interface SandboxPolicy {
  mode: PermissionMode;
  workspace: string;
  extraWritableDirs?: readonly string[];
  tempDir?: string;
  argv: readonly string[];
}
export type SandboxBackend = 'none' | 'bubblewrap' | 'seatbelt' | 'windows-acl';
export type SandboxCapabilityStatus = 'available' | 'unavailable' | 'deferred' | 'unsupported';
export type SandboxFailureCode =
  | 'sandbox_runner_missing'
  | 'sandbox_runner_nested'
  | 'sandbox_runner_failed'
  | 'sandbox_configuration_error'
  | 'sandbox_unsupported_platform';
export type SandboxDiagnosticCode = SandboxFailureCode | 'execution_policy_denied' | 'sandbox_policy_denied';
export interface SandboxCapability {
  backend: SandboxBackend;
  status: SandboxCapabilityStatus;
  reason: SandboxFailureCode | 'checked_per_launch' | null;
  detail: string | null;
}
export interface SandboxExecutionFailure {
  code: SandboxDiagnosticCode;
  stage: 'sandbox_runner' | 'command';
  commandStarted: boolean;
  backend: SandboxBackend;
  hint: string;
}
export interface ShellProcessPlan {
  argv: string[];
  env: NodeJS.ProcessEnv;
  backend: 'none' | 'bubblewrap' | 'seatbelt';
  cleanup(): void;
}

const boundedDetail=(value:string):string=>value.replace(/[\r\n]+/g,' ').trim().slice(0,300);
export function sandboxFailureHint(code:SandboxDiagnosticCode,backend:SandboxBackend):string {
  if(code==='sandbox_runner_nested')return '受限命令没有执行：macOS 无法应用 Seatbelt，BlackHole 本地服务可能已经运行在另一层应用或终端沙箱中。请从正常 VS Code/系统环境重启 BlackHole 本地服务后重试；不要通过 proxy 查找 exec/process，也不要自动放宽权限。';
  if(code==='sandbox_runner_missing')return `受限命令没有启动：系统缺少或阻止了 ${backend==='seatbelt'?'/usr/bin/sandbox-exec':backend==='bubblewrap'?'/usr/bin/bwrap':'所需沙箱运行器'}。请修复本机执行环境后重启 BlackHole 本地服务；不会静默改为无沙箱执行。`;
  if(code==='sandbox_runner_failed')return `受限命令没有执行：${backend} 沙箱运行器在启动用户命令前失败。请查看原始 stderr 和 BlackHole 日志，修复运行器或外层沙箱环境后再试；不要重复同一命令。`;
  if(code==='execution_policy_denied'||code==='sandbox_policy_denied')return `命令已经启动，但被 ${backend} 或操作系统权限策略拒绝。请核对失败路径、当前会话权限和工作区位置；审批通过不会扩大沙箱写入范围，也不会自动重跑。`;
  if(code==='sandbox_unsupported_platform')return '当前平台没有受支持的受限命令后端；命令未执行，也不会静默降级为无约束运行。';
  return '受限命令没有启动：沙箱配置无效或授权目录不可用。请检查工作区和可写目录后重试；不会静默改为无沙箱执行。';
}
export class SandboxError extends Error {
  readonly commandStarted=false;
  constructor(readonly code:SandboxFailureCode,readonly backend:SandboxBackend,detail:string,readonly hint=sandboxFailureHint(code,backend)){
    super(`SANDBOX_UNAVAILABLE [${code}]: ${boundedDetail(detail)}; refusing to run the command unconfined.`);
    this.name='SandboxError';
  }
}
const unavailable=(detail:string,code:SandboxFailureCode='sandbox_configuration_error',backend:SandboxBackend='none')=>new SandboxError(code,backend,detail);
function checkRoot(root:string):string {
  if(!root.startsWith('/')||/[\u0000-\u001f\u007f]/.test(root))throw unavailable('invalid sandbox path');
  if(root==='/'||/^\/(?:proc|sys|dev)(?:\/|$)/.test(root))throw unavailable('unsafe writable root');
  return root;
}
const literal=(value:string)=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';

/** Pure argv builder; all paths supplied by prepareShellProcess are canonical. */
export function sandboxArgv(platform:string,policy:SandboxPolicy):string[] {
  if(policy.mode==='danger-full-access')return [...policy.argv];
  if(!['read-only','workspace-write'].includes(policy.mode))throw unavailable('invalid permission mode');
  checkRoot(policy.workspace);
  const roots=policy.mode==='workspace-write'
    ? [...new Set([policy.workspace,...(policy.extraWritableDirs??[]),...(policy.tempDir?[policy.tempDir]:[])].map(checkRoot))]
    : [];
  if(platform==='linux'){
    const args=['/usr/bin/bwrap','--unshare-user','--unshare-pid','--unshare-ipc','--unshare-uts',
      '--die-with-parent','--new-session','--cap-drop','ALL','--ro-bind','/','/',
      '--dev','/dev','--proc','/proc'];
    for(const root of roots)args.push('--bind',root,root);
    return [...args,'--',...policy.argv];
  }
  if(platform==='darwin'){
    const profile=['(version 1)','(allow default)','(deny file-write*)',
      '(allow file-write* (literal "/dev/null"))'];
    if(roots.length)profile.push(`(allow file-write* ${roots.map(root=>`(subpath ${literal(root)})`).join(' ')})`);
    return ['/usr/bin/sandbox-exec','-p',profile.join(' '),...policy.argv];
  }
  throw unavailable(platform==='win32'?'the restricted Windows shell is not available':'unsupported platform '+platform,
    platform==='win32'?'sandbox_configuration_error':'sandbox_unsupported_platform',backendForPlatform(platform));
}

/** Never give a user command the daemon's cloud credentials or loader hooks. */
export function shellEnvironment(host:NodeJS.ProcessEnv=process.env):Record<string,string> {
  const env:Record<string,string>={PAGER:'cat',GIT_PAGER:'cat',NO_COLOR:'1',TERM:'dumb'};
  for(const key of ['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','SystemRoot','WINDIR','PATHEXT','ComSpec']){
    const value=process.platform==='win32'?windowsEnvValue(host,key):host[key];if(value!==undefined)env[key]=value;
  }
  if(process.platform==='win32'){
    env.PATH=windowsExecutionPath(env.PATH??'',host);
    env.PATHEXT||='.COM;.EXE;.BAT;.CMD';
  }
  return env;
}
type ProbeResult={status:number|null;stderr?:string;stdout?:string;error?:Error&{code?:string}};
type Probe=(file:string,args:string[])=>ProbeResult;
const defaultProbe:Probe=(file,args)=>spawnSync(file,args,{
  env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C'},encoding:'utf8',timeout:5000,maxBuffer:8192,
});
const backendForPlatform=(platform:string):SandboxBackend=>platform==='linux'?'bubblewrap':platform==='darwin'?'seatbelt':platform==='win32'?'windows-acl':'none';
const probeDetail=(result:ProbeResult):string=>boundedDetail(result.error?.message??result.stderr??result.stdout??`exit ${result.status}`);

/** Probe the runner itself. This never executes caller-provided code. */
export function inspectSandboxCapability(platform:string,probe:Probe=defaultProbe):SandboxCapability {
  const backend=backendForPlatform(platform);
  if(platform==='win32')return {backend,status:'deferred',reason:'checked_per_launch',detail:null};
  if(platform!=='linux'&&platform!=='darwin')return {backend:'none',status:'unsupported',reason:'sandbox_unsupported_platform',detail:`unsupported platform ${platform}`};
  const command=sandboxArgv(platform,{mode:'read-only',workspace:'/__blackhole_probe__',argv:['/usr/bin/true']});
  let result:ProbeResult;
  try { result=probe(command[0]!,command.slice(1)); }
  catch(error){ result={status:null,error:error instanceof Error?error:new Error(String(error))}; }
  if(!result.error&&result.status===0)return {backend,status:'available',reason:null,detail:null};
  const detail=probeDetail(result);
  const reason:SandboxFailureCode=result.error?.code==='ENOENT'
    ? 'sandbox_runner_missing'
    : backend==='seatbelt'&&/sandbox_apply:\s*Operation not permitted/i.test(detail)
      ? 'sandbox_runner_nested'
      : 'sandbox_runner_failed';
  return {backend,status:'unavailable',reason,detail};
}
const capabilityCache=new Map<string,SandboxCapability>();
/** One stable verdict per daemon lifetime; restart after changing the host sandbox/runtime. */
export function sandboxCapability(platform:string=process.platform,probe?:Probe):SandboxCapability {
  const cached=capabilityCache.get(platform);if(cached)return cached;
  const capability=inspectSandboxCapability(platform,probe??defaultProbe);capabilityCache.set(platform,capability);return capability;
}
export function resetSandboxCapabilityCacheForTests():void { capabilityCache.clear(); }
const capabilityError=(capability:SandboxCapability):SandboxError=>new SandboxError(
  capability.reason&&capability.reason!=='checked_per_launch'?capability.reason:'sandbox_runner_failed',
  capability.backend,
  capability.detail??`${capability.backend} is not available`,
);
export function probeRunner(platform:string,probe?:Probe):void {
  const capability=probe?inspectSandboxCapability(platform,probe):sandboxCapability(platform);
  if(capability.status!=='available')throw capabilityError(capability);
}

/** Classify post-spawn stderr without replacing the original output. */
export function classifySandboxStderr(stderr:string,backend:SandboxBackend,mode:PermissionMode,exitCode?:number|null):SandboxExecutionFailure|undefined {
  if(!stderr||exitCode===0||mode==='danger-full-access'||backend==='none'||backend==='windows-acl')return undefined;
  const lines=stderr.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  if(backend==='seatbelt'){
    const nested=lines.find(line=>/sandbox-exec:.*sandbox_apply:\s*Operation not permitted/i.test(line));
    if(nested)return {code:'sandbox_runner_nested',stage:'sandbox_runner',commandStarted:false,backend,hint:sandboxFailureHint('sandbox_runner_nested',backend)};
    const fatal=lines.find(line=>/^sandbox-exec:/i.test(line)&&!/\b(?:warning|deprecated)\b/i.test(line));
    if(fatal)return {code:'sandbox_runner_failed',stage:'sandbox_runner',commandStarted:false,backend,hint:sandboxFailureHint('sandbox_runner_failed',backend)};
  }
  if(backend==='bubblewrap'&&lines.some(line=>/^bwrap:/i.test(line)))return {
    code:'sandbox_runner_failed',stage:'sandbox_runner',commandStarted:false,backend,hint:sandboxFailureHint('sandbox_runner_failed',backend),
  };
  if(/\b(?:EPERM|EACCES|EROFS)\b|operation not permitted|permission denied|read-only file system|拒绝访问/i.test(stderr))return {
    code:'execution_policy_denied',stage:'command',commandStarted:true,backend,hint:sandboxFailureHint('execution_policy_denied',backend),
  };
  return undefined;
}
function canonicalDirectory(value:string):string {
  const real=fs.realpathSync(value);
  if(!fs.statSync(real).isDirectory())throw unavailable('sandbox root is not a directory');
  return checkRoot(real);
}

export function prepareShellProcess(policy:SandboxPolicy,extraEnv:Record<string,string>={}):ShellProcessPlan {
  const env=shellEnvironment();
  for(const [key,value] of Object.entries(extraEnv)){
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||value.includes('\0'))throw new Error('invalid command environment');
    env[key]=value;
  }
  if(policy.mode==='danger-full-access')return {argv:[...policy.argv],env,backend:'none',cleanup(){}};
  const platform=process.platform;
  if(platform!=='linux'&&platform!=='darwin')throw unavailable('a restricted Windows shell backend is required',
    platform==='win32'?'sandbox_configuration_error':'sandbox_unsupported_platform',backendForPlatform(platform));
  const workspace=canonicalDirectory(policy.workspace);
  const extraWritableDirs=policy.mode==='workspace-write'?(policy.extraWritableDirs??[]).map(canonicalDirectory):[];
  const capability=sandboxCapability(platform);
  if(capability.status!=='available')throw capabilityError(capability);
  // Private per-command temp authority; never grant the whole host /tmp tree.
  const tempDir=policy.mode==='workspace-write'?fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'blackhole-shell-'))):undefined;
  const cleanup=()=>{if(tempDir)fs.rmSync(tempDir,{recursive:true,force:true});};
  try {
    if(tempDir)env.TMPDIR=env.TMP=env.TEMP=tempDir;
    // Apply caller-supplied environment AFTER confinement. In particular,
    // LD_PRELOAD/DYLD_* must not be inherited by the sandbox launcher itself.
    const inner=['/usr/bin/env','-i',...Object.entries(env).map(([k,v])=>`${k}=${v}`),...policy.argv];
    return {argv:sandboxArgv(platform,{...policy,workspace,extraWritableDirs,tempDir,argv:inner}),
      env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C'},backend:platform==='linux'?'bubblewrap':'seatbelt',cleanup};
  } catch(error){cleanup();throw error;}
}
