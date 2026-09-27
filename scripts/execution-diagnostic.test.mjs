import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withExecutionDiagnostic as describe, executionErrorDiagnostic } from '../dist/workspace/execution-diagnostic.js';
import { SandboxError } from '../dist/workspace/posix-sandbox.js';
for (const stderr of ['Error: spawn EPERM', 'EACCES: open', 'Access is denied', 'Permission denied', '拒绝访问']) {
  test(`classifies execution error without replacing original: ${stderr}`, () => {
    const original = { exit_code: 1, stderr, stdout: 'partial work' };
    const r = describe(original, 'workspace-write');
    assert.equal(r.failure_kind, 'execution_permission_error'); assert.equal(r.stderr, stderr); assert.equal(r.stdout, original.stdout); assert.equal(r.exit_code, 1);
    assert.match(r.hint, /不是审批流程拒绝/); assert.match(r.hint, /未自动/); assert.equal(original.hint, undefined);
  });
}

// Timeout remains a normal structured exec outcome; callers must not treat it as an MCP protocol error.
assert.equal(describe({ exit_code: -1, timed_out: true, stdout: '', stderr: 'timeout' }, 'danger-full-access').timed_out, true);
for (const r of [{ exit_code: 0, stderr: 'example EPERM' }, { exit_code: 1, stderr: 'syntax error' }, { exit_code: -1, timed_out: true, stderr: 'EPERM' }]) {
  test(`leaves unrelated result unchanged: ${JSON.stringify(r)}`, () => assert.equal(describe(r, 'workspace-write'), r));
}
test('full access errors do not claim a sandbox root cause', () => {
  const r = describe({ exit_code: null, stderr: 'spawn EPERM' }, 'danger-full-access'); assert.match(r.hint, /danger-full-access/); assert.match(r.hint, /可能/);
});

for (const [tool, stderr] of [
  ['rg', "rg: The term 'rg' is not recognized as a name of a cmdlet"],
  ['grep', 'bash: grep: command not found'],
]) test(`missing ${tool} tells the agent not to retry it`, () => {
  const r=describe({exit_code:1,stderr,stdout:''},'workspace-write');
  assert.equal(r.failure_kind,'command_not_found'); assert.match(r.hint,new RegExp(`${tool} is unavailable`)); assert.match(r.hint,/Do not retry the same/);
  assert.match(r.hint, /inspect files with editor\./);
});

test('sandbox runner failure says the command never started',()=>{
 const error=new SandboxError('sandbox_runner_nested','seatbelt','sandbox-exec: sandbox_apply: Operation not permitted');
 const r=executionErrorDiagnostic(error,'workspace-write',{backend:'seatbelt',status:'unavailable',reason:'sandbox_runner_nested',detail:'sandbox_apply: Operation not permitted'});
 assert.equal(r.exit_code,null);assert.equal(r.failure_kind,'sandbox_runner_nested');assert.equal(r.failure_stage,'sandbox_runner');
 assert.equal(r.command_started,false);assert.equal(r.sandbox_backend,'seatbelt');assert.match(r.hint,/没有执行|未启动/);
});

test('runtime sandbox runner stderr outranks a command permission diagnosis',()=>{
 const r=describe({exit_code:71,stderr:'sandbox-exec: sandbox_apply: Operation not permitted',stdout:''},'workspace-write',
  {backend:'seatbelt',status:'available',reason:null,detail:null});
 assert.equal(r.failure_kind,'sandbox_runner_nested');assert.equal(r.failure_stage,'sandbox_runner');assert.equal(r.command_started,false);
});

test('a launched restricted command denied by the OS policy is distinct from runner failure',()=>{
 const r=describe({exit_code:1,stderr:'zsh: operation not permitted: ./tool',stdout:''},'workspace-write',
  {backend:'seatbelt',status:'available',reason:null,detail:null});
 assert.equal(r.failure_kind,'execution_policy_denied');assert.equal(r.failure_stage,'command');assert.equal(r.command_started,true);
 assert.match(r.hint,/命令已经启动|执行阶段/);
});

for (const backend of ['seatbelt', 'bubblewrap']) test('successful or unconfined output cannot be diagnosed as a ' + backend + ' launcher failure', async () => {
  const { classifySandboxStderr } = await import('../dist/workspace/posix-sandbox.js');
  const stderr = backend === 'seatbelt' ? 'sandbox-exec: sandbox_apply: Operation not permitted' : 'bwrap: sample diagnostic';
  assert.equal(classifySandboxStderr(stderr, backend, 'workspace-write', 0), undefined, 'stderr can contain quoted diagnostics in a successful command');
  assert.equal(classifySandboxStderr(stderr, backend, 'danger-full-access', 1), undefined, 'no BlackHole sandbox runner was applied in this mode');
});
