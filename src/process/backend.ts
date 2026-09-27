import { ProcessError, type ProcessBackend } from './types.js';
import type { ShellMetadata } from '../execution.js';
import fs from 'node:fs';

export function processPlatformSupported(platform: string, arch: string): boolean {
  return platform === 'win32' ? arch === 'x64' : ['linux', 'darwin'].includes(platform) && ['x64', 'arm64'].includes(arch);
}
export const processSupported = processPlatformSupported(process.platform, process.arch);
export interface ProcessRuntimeCapability { available: boolean; reason?: 'unsupported_platform' | 'runtime_asset_missing' }
/** Startup fact for tool registration; never launches user code. */
export async function processRuntimeCapability(platform:string=process.platform,arch:string=process.arch,exists:(file:string)=>boolean=fs.existsSync):Promise<ProcessRuntimeCapability> {
  if(!processPlatformSupported(platform,arch))return {available:false,reason:'unsupported_platform'};
  if(platform==='win32')return {available:true};
  const {supervisorPath}=await import('./posix.js');
  return exists(supervisorPath())?{available:true}:{available:false,reason:'runtime_asset_missing'};
}

/** Resolve once; POSIX never imports Windows native modules. Runtime assets are checked at startup; sandbox policy still applies per launch. */
export async function loadProcessBackend(shell?: ShellMetadata): Promise<ProcessBackend> {
  if (processSupported && process.platform === 'win32') {
    const { startWindowsProcess } = await import('./windows.js');
    return (spec, callbacks) => startWindowsProcess(spec, callbacks, shell);
  }
  if (processSupported) {
    const { startPosixProcess } = await import('./posix.js');
    return (spec, callbacks) => startPosixProcess(spec, callbacks, shell?.executable);
  }
  return () => { throw new ProcessError('unsupported_platform', 'Managed processes are unavailable on this platform; no unconfined fallback is used.'); };
}
