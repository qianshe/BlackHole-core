import { createRequire } from 'node:module';
import type { NativePtr } from '../win32/ffi.js';

// The proxy is imported on every OS. Do not import ffi/koffi until a Windows
// operation actually needs it (including when the daemon is bundled as CJS).
let native: typeof import('../win32/ffi.js') | undefined;
function nativeBindings(): typeof import('../win32/ffi.js') {
  if (process.platform !== 'win32') throw new Error('Windows job objects are unavailable on this platform');
  const base = typeof __filename === 'string' ? __filename : import.meta.url;
  return native ??= createRequire(base)('../win32/ffi.js') as typeof import('../win32/ffi.js');
}

/**
 * upstream child 的 Windows 硬保证（plan §8.1）：把 child 进程放进一个
 * KILL_ON_JOB_CLOSE 的 Job Object——daemon 无论怎么死（含 taskkill /f），
 * 句柄随进程关闭、child 被系统整树回收。
 *
 * 复用 acl-sandbox 的 koffi FFI 层（src/win32/ffi.ts）。约束（plan v2.2）：
 * upstream child 不经 acl-sandbox spawn 路径产生——一个进程只能属于一个 job，
 * 这里走普通 spawn + 事后 AssignProcessToJobObject；与 sandbox job 按互斥设计。
 * spawn 到 assign 之间的毫秒级窗口由 pid registry 启动清扫兜底。
 */

const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

/**
 * 把已存在的 pid 分配进新建的 kill-on-close job。返回的 job 句柄必须由调用方
 * 保存并在 child 存活期保持打开——所有句柄关闭（含 daemon 进程死亡）即触发
 * 整树终止。非 Windows 返回 null，使用 POSIX 进程生命周期逻辑。
 * Windows 的 native runtime 或 Job 创建失败会抛错，不降级为无 Job 运行。
 */
export function assignPidToKillOnCloseJob(pid: number): NativePtr | null {
  if (globalThis.process.platform !== 'win32') return null;
  const { win32, isNullPtr, errorText, JobObjectExtendedLimitInformation,
    JOBOBJECT_EXTENDED_LIMIT_SIZE, JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE } = nativeBindings();
  const api = win32(); // On Windows, a missing native runtime must fail closed.
  const job = api.createJobObjectW(null, null);
  if (isNullPtr(job)) throw new Error(`CreateJobObjectW failed: ${errorText(api, api.getLastError())}`);
  const info = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_SIZE);
  info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET);
  if (api.setInformationJobObject(job, JobObjectExtendedLimitInformation, info, info.length) === 0) {
    const code = api.getLastError();
    api.closeHandle(job);
    throw new Error(`SetInformationJobObject failed: ${errorText(api, code)}`);
  }
  // PROCESS_SET_QUOTA | PROCESS_TERMINATE 是 AssignProcessToJobObject 的最小权限集
  const process = api.openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
  if (isNullPtr(process)) {
    const code = api.getLastError();
    api.closeHandle(job);
    throw new Error(`OpenProcess(${pid}) failed: ${errorText(api, code)}`);
  }
  try {
    if (api.assignProcessToJobObject(job, process) === 0) {
      const code = api.getLastError();
      throw new Error(`AssignProcessToJobObject(${pid}) failed: ${errorText(api, code)}`);
    }
  } finally {
    api.closeHandle(process); // job 持有自己的引用，关闭进程句柄不影响成员资格
  }
  return job;
}

/** 优雅路径关闭 job 句柄（child 已退出时调用；daemon 崩溃时系统代劳）。 */
export function closeJobHandle(job: NativePtr | null): void {
  if (job === null) return;
  try {
    nativeBindings().win32().closeHandle(job);
  } catch {
    /* 句柄已失效即已达到目的 */
  }
}
