import koffi from 'koffi';

/**
 * Win32 ACL-sandbox FFI layer. Koffi loads lazily so non-Windows processes
 * never open Win32 libraries. Every binding is checked at every call site —
 * a failure throws with the API name and the exact Win32 code; the caller
 * fails closed.
 * @module win32/ffi
 */

/** koffi pointer to void. */
const PVOID = koffi.pointer('void');
const PPVOID = koffi.pointer(PVOID);

/** koffi 3 native pointer (a BigInt address). */
export type NativePtr = bigint & { readonly brand: unique symbol };

/** True for NULL pointers, however koffi returns them (null or 0n). */
export function isNullPtr(value: NativePtr | null | undefined): value is null | undefined {
  return value === null || value === undefined || (value as bigint) === 0n;
}

// ---- ABI constants (verified against the MinGW Windows headers) ----
export const TOKEN_QUERY = 0x0008;
export const TOKEN_DUPLICATE = 0x0002;
export const TOKEN_ADJUST_DEFAULT = 0x0080;
export const TOKEN_ASSIGN_PRIMARY = 0x0001;
export const SE_GROUP_LOGON_ID = 0xc0000000;
export const FILE_GENERIC_WRITE = 0x00120116;
export const STANDARD_RIGHTS_WRITE = 0x00020000;
export const DELETE = 0x00010000;
export const FILE_DELETE_CHILD = 0x0040;
/** Write+delete mask ("Modify" in icacls); WRITE_DAC/WRITE_OWNER excluded. */
export const GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE;
export const FILE_ALL_ACCESS = 0x1f01ff;
export const DISABLE_MAX_PRIVILEGE = 0x1;
export const LUA_TOKEN = 0x4;
export const WRITE_RESTRICTED = 0x8;
export const WinWorldSid = 1;
export const TokenGroups = 2;
export const TokenDefaultDacl = 6;
export const DACL_SECURITY_INFORMATION = 0x00000004;
export const PROCESS_QUERY_INFORMATION = 0x0400;
export const SE_FILE_OBJECT = 1;
export const TRUSTEE_IS_UNKNOWN = 0;
export const TRUSTEE_IS_SID = 0;
export const NO_MULTIPLE_TRUSTEE = 0;
export const GRANT_ACCESS = 1;
export const REVOKE_ACCESS = 4;
export const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3;
export const STARTF_USESTDHANDLES = 0x00000100;
export const STARTF_USESHOWWINDOW = 0x00000001;
export const SW_HIDE = 0;
export const HANDLE_FLAG_INHERIT = 0x1;
export const INFINITE = 0xffffffff;
export const MAX_PATH = 260;
export const CREATE_SUSPENDED = 0x4;
/** CREATE_NO_WINDOW: invisible console — no window pop for console-less parents. */
export const CREATE_NO_WINDOW = 0x08000000;
export const ERROR_SUCCESS = 0;
export const ERROR_BROKEN_PIPE = 109;
export const ERROR_NO_DATA = 232;
export const GENERIC_READ = 0x80000000;
export const GENERIC_WRITE = 0x40000000;
export const FILE_SHARE_READ = 0x1;
export const FILE_SHARE_WRITE = 0x2;
export const OPEN_ALWAYS = 4;
export const LOCKFILE_EXCLUSIVE_LOCK = 0x2;
export const ACCESS_ALLOWED_ACE_TYPE = 0;
export const SID_MAX_SUB_AUTHORITIES = 15;
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
export const JobObjectExtendedLimitInformation = 9;
export const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144;
export const JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16;
export const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000;
export const FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200;
// struct layouts (x64)
export const SECURITY_MAX_SID_SIZE = 68;
export const SID_AND_ATTRIBUTES_SIZE = 16;
export const TOKEN_GROUPS_OFFSET = 8;
export const EXPLICIT_ACCESS_W_SIZE = 48;
export const STARTUPINFOW_SIZE = 104;
export const PROCESS_INFORMATION_SIZE = 24;

const STARTUPINFOW = koffi.struct('BH_STARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'str16',
  lpDesktop: 'str16',
  lpTitle: 'str16',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: koffi.pointer('uint8'),
  hStdInput: PVOID,
  hStdOutput: PVOID,
  hStdError: PVOID,
});
const PROCESS_INFORMATION = koffi.struct('BH_PROCESS_INFORMATION', {
  hProcess: PVOID,
  hThread: PVOID,
  dwProcessId: 'uint32',
  dwThreadId: 'uint32',
});

export interface Win32Bindings {
  openProcess(desiredAccess: number, inheritHandle: number, pid: number): NativePtr;
  openProcessToken(process: NativePtr, desiredAccess: number, tokenHandle: NativePtr): number;
  closeHandle(handle: NativePtr): number;
  getLastError(): number;
  formatMessageW(flags: number, source: null, messageId: number, languageId: number, buffer: Buffer, size: number, args: null): number;
  localAlloc(flags: number, bytes: number): NativePtr;
  localFree(memory: NativePtr): NativePtr;
  convertStringSidToSidW(stringSid: string, sid: NativePtr): number;
  createWellKnownSid(type: number, domainSid: null, sid: NativePtr, size: NativePtr): number;
  isValidSid(sid: NativePtr): number;
  getLengthSid(sid: NativePtr): number;
  copySid(length: number, destination: NativePtr, source: NativePtr): number;
  getTokenInformation(token: NativePtr, cls: number, info: Buffer | null, length: number, needed: NativePtr): number;
  setTokenInformation(token: NativePtr, cls: number, info: Buffer, length: number): number;
  createRestrictedToken(
    existing: NativePtr, flags: number,
    disableCount: number, disableSids: null,
    deletePrivilegeCount: number, privilegesToDelete: null,
    restrictCount: number, restrictingSids: Buffer,
    newToken: NativePtr,
  ): number;
  setEntriesInAclW(count: number, entries: Buffer, oldAcl: NativePtr | null, newAcl: NativePtr): number;
  setNamedSecurityInfoW(
    path: string, objectType: number, information: number,
    owner: null, group: null, dacl: NativePtr | null, sacl: null,
  ): number;
  getNamedSecurityInfoW(
    path: string, objectType: number, information: number,
    owner: NativePtr, group: NativePtr, dacl: NativePtr, sacl: NativePtr, descriptor: NativePtr,
  ): number;
  getTempPathW(length: number, buffer: Buffer): number;
  createFileW(
    fileName: string, desiredAccess: number, shareMode: number, attributes: null,
    creationDisposition: number, flagsAndAttributes: number, templateFile: null,
  ): NativePtr;
  lockFileEx(file: NativePtr, flags: number, reserved: number, bytesLow: number, bytesHigh: number, overlapped: NativePtr): number;
  unlockFileEx(file: NativePtr, reserved: number, bytesLow: number, bytesHigh: number, overlapped: NativePtr): number;
  createPipe(readHandle: NativePtr, writeHandle: NativePtr, attributes: null, size: number): number;
  setHandleInformation(handle: NativePtr, mask: number, flags: number): number;
  createProcessAsUserW(
    token: NativePtr, applicationName: null, commandLine: string,
    processAttributes: null, threadAttributes: null,
    inheritHandles: number, creationFlags: number, environment: Buffer | null,
    currentDirectory: string | null, startupInfo: NativePtr, processInfo: NativePtr,
  ): number;
  readFile(file: NativePtr, buffer: Buffer, count: number, bytesRead: NativePtr, overlapped: null): number;
  writeFile(file: NativePtr, buffer: Buffer, count: number, bytesWritten: NativePtr, overlapped: null): number;
  peekNamedPipe(pipe: NativePtr, buffer: null, size: number, bytesRead: NativePtr, totalAvail: NativePtr, leftThisMessage: NativePtr): number;
  waitForSingleObject(handle: NativePtr, milliseconds: number): number;
  getExitCodeProcess(process: NativePtr, exitCode: NativePtr): number;
  resumeThread(thread: NativePtr): number;
  createJobObjectW(attributes: null, name: null): NativePtr;
  setInformationJobObject(job: NativePtr, cls: number, information: Buffer, length: number): number;
  assignProcessToJobObject(job: NativePtr, process: NativePtr): number;
  terminateProcess(process: NativePtr, exitCode: number): number;
  terminateJobObject(job: NativePtr, exitCode: number): number;
  queryInformationJobObject(job: NativePtr, cls: number, information: Buffer, length: number, needed: null): number;
}

let cached: Win32Bindings | undefined;

/** Resolve the binding table (cached; throws on the first failure). */
export function win32(): Win32Bindings {
  if (cached !== undefined) return cached;
  const kernel32 = koffi.load('kernel32.dll');
  const advapi32 = koffi.load('advapi32.dll');
  type FnSpec = { name: string; lib: ReturnType<typeof koffi.load>; result: string; args: string[] };
  const specs: FnSpec[] = [
    { name: 'OpenProcess', lib: kernel32, result: 'void *', args: ['uint32', 'int', 'uint32'] },
    { name: 'OpenProcessToken', lib: advapi32, result: 'int', args: ['void *', 'uint32', 'void **'] },
    { name: 'CloseHandle', lib: kernel32, result: 'int', args: ['void *'] },
    { name: 'GetLastError', lib: kernel32, result: 'uint32', args: [] },
    { name: 'FormatMessageW', lib: kernel32, result: 'uint32', args: ['uint32', 'void *', 'uint32', 'uint32', 'void *', 'uint32', 'void *'] },
    { name: 'LocalAlloc', lib: kernel32, result: 'void *', args: ['uint32', 'size_t'] },
    { name: 'LocalFree', lib: kernel32, result: 'void *', args: ['void *'] },
    { name: 'ConvertStringSidToSidW', lib: advapi32, result: 'int', args: ['str16', 'void **'] },
    { name: 'CreateWellKnownSid', lib: advapi32, result: 'int', args: ['int', 'void *', 'void *', 'uint32 *'] },
    { name: 'IsValidSid', lib: advapi32, result: 'int', args: ['void *'] },
    { name: 'GetLengthSid', lib: advapi32, result: 'uint32', args: ['void *'] },
    { name: 'CopySid', lib: advapi32, result: 'int', args: ['uint32', 'void *', 'void *'] },
    { name: 'GetTokenInformation', lib: advapi32, result: 'int', args: ['void *', 'int', 'void *', 'uint32', 'uint32 *'] },
    { name: 'SetTokenInformation', lib: advapi32, result: 'int', args: ['void *', 'int', 'void *', 'uint32'] },
    { name: 'CreateRestrictedToken', lib: advapi32, result: 'int', args: ['void *', 'uint32', 'uint32', 'void *', 'uint32', 'void *', 'uint32', 'void *', 'void **'] },
    { name: 'SetEntriesInAclW', lib: advapi32, result: 'uint32', args: ['uint32', 'void *', 'void *', 'void **'] },
    { name: 'SetNamedSecurityInfoW', lib: advapi32, result: 'uint32', args: ['str16', 'int', 'uint32', 'void *', 'void *', 'void *', 'void *'] },
    { name: 'GetNamedSecurityInfoW', lib: advapi32, result: 'uint32', args: ['str16', 'int', 'uint32', 'void **', 'void **', 'void **', 'void **', 'void **'] },
    { name: 'GetTempPathW', lib: kernel32, result: 'uint32', args: ['uint32', 'void *'] },
    { name: 'CreateFileW', lib: kernel32, result: 'void *', args: ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *'] },
    { name: 'LockFileEx', lib: kernel32, result: 'int', args: ['void *', 'uint32', 'uint32', 'uint32', 'uint32', 'void *'] },
    { name: 'UnlockFileEx', lib: kernel32, result: 'int', args: ['void *', 'uint32', 'uint32', 'uint32', 'void *'] },
    { name: 'CreatePipe', lib: kernel32, result: 'int', args: ['void **', 'void **', 'void *', 'uint32'] },
    { name: 'SetHandleInformation', lib: kernel32, result: 'int', args: ['void *', 'uint32', 'uint32'] },
    { name: 'ReadFile', lib: kernel32, result: 'int', args: ['void *', 'void *', 'uint32', 'uint32 *', 'void *'] },
    { name: 'WriteFile', lib: kernel32, result: 'int', args: ['void *', 'void *', 'uint32', 'uint32 *', 'void *'] },
    { name: 'PeekNamedPipe', lib: kernel32, result: 'int', args: ['void *', 'void *', 'uint32', 'uint32 *', 'uint32 *', 'uint32 *'] },
    { name: 'WaitForSingleObject', lib: kernel32, result: 'uint32', args: ['void *', 'uint32'] },
    { name: 'GetExitCodeProcess', lib: kernel32, result: 'int', args: ['void *', 'uint32 *'] },
    { name: 'ResumeThread', lib: kernel32, result: 'uint32', args: ['void *'] },
    { name: 'CreateJobObjectW', lib: kernel32, result: 'void *', args: ['void *', 'str16'] },
    { name: 'SetInformationJobObject', lib: kernel32, result: 'int', args: ['void *', 'int', 'void *', 'uint32'] },
    { name: 'AssignProcessToJobObject', lib: kernel32, result: 'int', args: ['void *', 'void *'] },
    { name: 'TerminateProcess', lib: kernel32, result: 'int', args: ['void *', 'uint32'] },
    { name: 'TerminateJobObject', lib: kernel32, result: 'int', args: ['void *', 'uint32'] },
    { name: 'QueryInformationJobObject', lib: kernel32, result: 'int', args: ['void *', 'int', 'void *', 'uint32', 'void *'] },
  ];
  const fn = (spec: FnSpec): ((...fnArgs: unknown[]) => unknown) => {
    const bound = spec.lib.func('__stdcall', spec.name, spec.result, spec.args);
    return bound as (...fnArgs: unknown[]) => unknown;
  };
  const table: Record<string, (...fnArgs: unknown[]) => unknown> = {};
  for (const spec of specs) table[camel(spec.name)] = fn(spec);
  // CreateProcessAsUserW needs the struct-typed STARTUPINFOW/PROCESS_INFORMATION
  table.createProcessAsUserW = advapi32.func('__stdcall', 'CreateProcessAsUserW', 'int', [
    'void *', 'str16', 'str16', 'void *', 'void *', 'int', 'uint32', 'void *', 'str16',
    koffi.pointer(STARTUPINFOW), koffi.pointer(PROCESS_INFORMATION),
  ]) as unknown as (...fnArgs: unknown[]) => unknown;
  cached = table as unknown as Win32Bindings;
  return cached;
}

/** OpenProcess → openProcess (first letter lowercase). */
function camel(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** Allocate one pointer-sized slot (for `T **` out-parameters). */
export function allocPtrSlot(): NativePtr {
  return koffi.alloc(PVOID, 1) as unknown as NativePtr;
}

/** Allocate one uint32 slot. */
export function allocUint32(): NativePtr {
  return koffi.alloc('uint32', 1) as unknown as NativePtr;
}

/** Write a uint32 into a slot. */
export function encodeUint32(slot: NativePtr, value: number): void {
  koffi.encode(slot, 'uint32', value);
}

/** Decode a pointer stored in a slot (NULL becomes null). */
export function decodePtr(slot: NativePtr): NativePtr | null {
  const value = koffi.decode(slot, PVOID) as unknown;
  if (isNullPtr(value as NativePtr | null | undefined)) return null;
  return value as NativePtr;
}

/** Decode a uint32 at a slot. */
export function decodeUint32(slot: NativePtr): number {
  return koffi.decode(slot, 'uint32') as unknown as number;
}

/** Cast a koffi pointer to its BigInt address (for raw struct packing). */
export function ptrAddress(ptr: NativePtr): bigint {
  return koffi.address(ptr);
}

/** Allocate a raw byte block. */
export function allocBytes(length: number): NativePtr {
  return koffi.alloc('uint8', length) as unknown as NativePtr;
}

/** One zeroed OVERLAPPED (32 bytes) — LockFileEx with NULL crashes koffi 3. */
export function allocOverlapped(): NativePtr {
  return allocBytes(32);
}

/** Decode a pointer VALUE stored at buffer[offset]. */
export function decodePtrAt(buffer: Buffer, offset: number): NativePtr | null {
  const value = koffi.decode(buffer, offset, PVOID) as unknown;
  if (isNullPtr(value as NativePtr | null | undefined)) return null;
  return value as NativePtr;
}

/** Decode a uint8 at a native pointer plus offset. */
export function decodeUint8At(ptr: NativePtr, offset: number): number {
  return koffi.decode(ptr, offset, 'uint8') as unknown as number;
}

/** Decode a uint16 at a native pointer plus offset. */
export function decodeUint16At(ptr: NativePtr, offset: number): number {
  return koffi.decode(ptr, offset, 'uint16') as unknown as number;
}

/** Decode a uint32 at a native pointer plus offset. */
export function decodeUint32At(ptr: NativePtr, offset: number): number {
  return koffi.decode(ptr, offset, 'uint32') as unknown as number;
}

/** Compare two SIDs field-by-field via bounded offset reads (never struct-decode). */
export function sameSidAt(left: NativePtr, leftOffset: number, right: NativePtr, rightOffset: number): boolean {
  if (decodeUint8At(left, leftOffset) !== decodeUint8At(right, rightOffset)) return false;
  const leftCount = decodeUint8At(left, leftOffset + 1);
  const rightCount = decodeUint8At(right, rightOffset + 1);
  if (leftCount !== rightCount || leftCount > SID_MAX_SUB_AUTHORITIES) return false;
  for (let index = 0; index < 6; index++) {
    if (decodeUint8At(left, leftOffset + 2 + index) !== decodeUint8At(right, rightOffset + 2 + index)) return false;
  }
  for (let index = 0; index < leftCount; index++) {
    if (decodeUint32At(left, leftOffset + 8 + index * 4) !== decodeUint32At(right, rightOffset + 8 + index * 4)) return false;
  }
  return true;
}

/** Allocate a zeroed STARTUPINFOW. */
export function allocStartupInfo(): NativePtr {
  return koffi.alloc(STARTUPINFOW, 1) as unknown as NativePtr;
}

/** Write the stdio-relevant STARTUPINFOW fields. */
export function encodeStartupInfo(startupInfo: NativePtr, fields: { cb: number; dwFlags: number; wShowWindow?: number; hStdInput: NativePtr; hStdOutput: NativePtr; hStdError: NativePtr }): void {
  koffi.encode(startupInfo, STARTUPINFOW, fields);
}

/** Allocate a zeroed PROCESS_INFORMATION. */
export function allocProcessInfo(): NativePtr {
  return koffi.alloc(PROCESS_INFORMATION, 1) as unknown as NativePtr;
}

/** Decode PROCESS_INFORMATION after CreateProcessAsUserW. */
export function decodeProcessInfo(processInfo: NativePtr): { hProcess: NativePtr | null; hThread: NativePtr | null; dwProcessId: number } {
  const value = koffi.decode(processInfo, PROCESS_INFORMATION) as unknown as {
    hProcess: NativePtr | null; hThread: NativePtr | null; dwProcessId: number;
  };
  return value;
}

/** Format a Win32 error code via FormatMessageW ('' on failure). */
export function errorText(api: Win32Bindings, win32Code: number): string {
  const buffer = Buffer.alloc(1024);
  const length = api.formatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, null, win32Code, 0, buffer, buffer.length / 2, null);
  if (length === 0) return '';
  return buffer.subarray(0, length * 2).toString('utf16le').trim();
}

/** Throw for a BOOL-style failure — call immediately so GetLastError is fresh. */
export function throwLastError(api: Win32Bindings, name: string, detail?: string): never {
  const win32Code = api.getLastError();
  throw new Error(`Win32 ${name} failed (${win32Code}): ${detail ?? errorText(api, win32Code)}`);
}

/** Throw for an HRESULT-style return (the value IS the code). */
export function throwWin32(api: Win32Bindings, name: string, win32Code: number, detail?: string): never {
  throw new Error(`Win32 ${name} failed (${win32Code}): ${detail ?? errorText(api, win32Code)}`);
}
