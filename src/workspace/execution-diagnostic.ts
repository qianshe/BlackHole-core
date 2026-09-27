import type { PermissionMode } from '../config.js';
import { WORKSPACE_FILE_TOOL } from '../tool-routing.js';
import { SandboxError, classifySandboxStderr, type SandboxCapability } from './posix-sandbox.js';

export interface ExecutionDiagnosticFields {
  failure_kind?: string;
  failure_stage?: 'launch' | 'sandbox_runner' | 'command';
  command_started?: boolean;
  sandbox_backend?: SandboxCapability['backend'];
  hint?: string;
}

/** Convert pre-spawn failures into the same bounded, machine-readable exec shape. */
export function executionErrorDiagnostic(error:unknown,mode:PermissionMode,sandbox?:SandboxCapability):{
  exit_code:null;stdout:string;stderr:string;failure_kind:string;failure_stage:'launch'|'sandbox_runner';command_started:false;sandbox_backend?:SandboxCapability['backend'];hint:string;
} {
  if(error instanceof SandboxError)return {
    exit_code:null,stdout:'',stderr:error.message,failure_kind:error.code,failure_stage:'sandbox_runner',command_started:false,
    sandbox_backend:error.backend,hint:error.hint,
  };
  const message=error instanceof Error?error.message:String(error);
  return {
    exit_code:null,stdout:'',stderr:message,failure_kind:'execution_start_failed',failure_stage:'launch',command_started:false,
    ...(sandbox?{sandbox_backend:sandbox.backend}:{}),
    hint:`命令没有启动（会话模式：${mode}）。请检查声明的 shell、工作区路径和本机执行环境；本次未自动重试或放宽权限。`,
  };
}

/** Presentation only: never changes policy, approves, or retries a command. */
export function withExecutionDiagnostic<T extends { exit_code: number | null; stderr: string; timed_out?: boolean }>(result: T, mode: PermissionMode, sandbox?: SandboxCapability): T & ExecutionDiagnosticFields {
  if (result.exit_code === 0 || result.timed_out) return result;
  const sandboxFailure=sandbox?classifySandboxStderr(result.stderr,sandbox.backend,mode):undefined;
  if(sandboxFailure)return {
    ...result,failure_kind:sandboxFailure.code,failure_stage:sandboxFailure.stage,command_started:sandboxFailure.commandStarted,
    sandbox_backend:sandboxFailure.backend,hint:sandboxFailure.hint,
  };
  const missing = result.stderr.match(/(?:^|\s)(rg|grep)(?::|\s).*?(?:not recognized|not found|not found as|command not found|无法将|不是内部或外部命令)/i)?.[1]?.toLowerCase();
  if (missing) return {
    ...result,
    failure_kind: 'command_not_found',failure_stage:'command',command_started:true,
    ...(sandbox?{sandbox_backend:sandbox.backend}:{}),
    hint: `${missing} is unavailable in this exec environment. Do not retry the same ${missing} command. Use ${missing === 'rg' ? 'grep or another available search command' : 'rg or another available search command'}, or inspect files with ${WORKSPACE_FILE_TOOL}.`,
  };
  if (!/\b(?:EPERM|EACCES|EROFS)\b|access (?:is )?denied|operation not permitted|permission denied|read-only file system|拒绝访问/i.test(result.stderr)) return result;
  return {
    ...result,
    failure_kind: 'execution_permission_error',failure_stage:'command',command_started:true,
    ...(sandbox?{sandbox_backend:sandbox.backend}:{}),
    hint: `命令已进入执行阶段并报告权限错误（会话模式：${mode}），不是审批流程拒绝。错误可能来自沙箱、操作系统或子程序；请结合原始 stderr 核对失败资源及所需权限。审批通过不会扩大沙箱权限。本次未自动申请额外权限或重跑；重试前请确认命令是否已部分执行。`,
  };
}
