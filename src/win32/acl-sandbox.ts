import koffi from 'koffi';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ACCESS_ALLOWED_ACE_TYPE, CREATE_SUSPENDED, DACL_SECURITY_INFORMATION,
  ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_SUCCESS, FILE_ALL_ACCESS, FILE_SHARE_READ,
  FILE_SHARE_WRITE, GENERIC_READ, GENERIC_WRITE, GRANT_ACCESS, GRANT_MASK, INFINITE,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JobObjectExtendedLimitInformation,
  JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET, JOBOBJECT_EXTENDED_LIMIT_SIZE, OPEN_ALWAYS,
  PROCESS_QUERY_INFORMATION, REVOKE_ACCESS, SE_FILE_OBJECT, SE_GROUP_LOGON_ID,
  SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES_SIZE, STARTF_USESTDHANDLES, STARTF_USESHOWWINDOW, SW_HIDE, STARTUPINFOW_SIZE,
  SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY,
  TOKEN_DUPLICATE, TOKEN_GROUPS_OFFSET, TOKEN_QUERY, TokenDefaultDacl, TokenGroups,
  TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, NO_MULTIPLE_TRUSTEE, WinWorldSid,
  allocBytes, allocOverlapped, allocPtrSlot, allocStartupInfo, allocProcessInfo, allocUint32,
  decodePtr, decodePtrAt, decodeProcessInfo, decodeUint16At, decodeUint32,
  decodeUint32At, decodeUint8At, encodeStartupInfo, encodeUint32, isNullPtr,
  ptrAddress, sameSidAt, throwLastError, throwWin32, win32,
  type NativePtr, type Win32Bindings,
} from './ffi.js';

/**
 * Windows ACL write-restriction sandbox, based on the WRITE_RESTRICTED
 * token mechanism of github.com/huoyaoyuan/windows-acl-restrict-poc (MIT).
 * The mechanism: duplicate
 * the daemon's token into a WRITE_RESTRICTED token whose restricting SIDs
 * carry the workspace + per-session temp capabilities; grant those SIDs Write
 * ACEs on exactly their owning directories; the token's pass-2 intersection
 * check then allows writes ONLY where both the normal ACL and a restricting
 * SID's ACE agree. Every Win32 call is checked — a failure throws and the
 * child is NEVER spawned unrestricted (fail-closed).
 *
 * Known boundaries (inherent to WRITE_RESTRICTED):
 *  - reads, network, and process visibility are NOT restricted;
 *  - the Everyone keep-alive SID's ambient write grants remain (why the
 *    backend reports `partial`, not `full`, enforcement);
 *  - the workspace and temp directories must be caller-owned (WRITE_DAC).
 * @module win32/acl-sandbox
 */

/** Restricting-SID keep-alive group members. */
type SidSet = { logon: NativePtr; world: NativePtr };

/** Deterministic per-workspace write SID (S-1-4-x-y) — the reuse identity. */
export function workspaceWriteSid(workspaceRoot: string): string {
  const digest = createHash('sha256').update(workspaceRoot, 'utf8').digest();
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1;
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1;
  return `S-1-4-${first}-${second}`;
}

/** Per-session private temp SID (S-1-4-x-y-1) — domain-separated from workspace SIDs. */
export function tempWriteSid(tempDir: string): string {
  const digest = createHash('sha256').update('temp\0', 'utf8').update(tempDir, 'utf8').digest();
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1;
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1;
  return `S-1-4-${first}-${second}-1`;
}

function containsDirectory(root: string, candidate: string): boolean {
  const relation = relative(realpathSync.native(root), realpathSync.native(candidate));
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`));
}

/** Reject a temp dir that overlaps a writable dir (either direction merges capabilities). */
function assertTempDisjoint(writableDirs: readonly string[], tempDir: string): void {
  for (const dir of writableDirs) {
    if (containsDirectory(dir, tempDir) || containsDirectory(tempDir, dir)) {
      throw new Error(`sandbox temp dir must be disjoint from writable dirs: writable=${dir}; temp=${tempDir}`);
    }
  }
}

// ---- lock files (serialize concurrent DACL edits on one path) ----

function lockFilePath(api: Win32Bindings, dir: string): string {
  const digest = createHash('sha256').update(dir.toLowerCase()).digest('hex').slice(0, 16);
  return join(getTempPath(api), 'bh-acl-locks', `${digest}.lock`);
}

function getTempPath(api: Win32Bindings): string {
  const buffer = Buffer.alloc((260 + 1) * 2);
  const length = api.getTempPathW(buffer.length / 2, buffer);
  if (length === 0) throwLastError(api, 'GetTempPathW');
  if (length > buffer.length / 2) throw new Error(`GetTempPathW: required ${length} chars exceed buffer`);
  return buffer.subarray(0, length * 2).toString('utf16le');
}

function withPathLock<T>(api: Win32Bindings, dir: string, action: () => T): T {
  const lockPath = lockFilePath(api, dir);
  mkdirSync(dirname(lockPath), { recursive: true });
  const handle = api.createFileW(lockPath, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, null, OPEN_ALWAYS, 0, null);
  if (handle === 0xffffffffffffffffn || handle === -1n || isNullPtr(handle)) throwLastError(api, 'CreateFileW', lockPath);
  const overlapped = allocOverlapped();
  if (api.lockFileEx(handle, 0x2 /* exclusive */, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError();
    api.closeHandle(handle);
    throwWin32(api, 'LockFileEx', win32Code, lockPath);
  }
  let result: T;
  try {
    result = action();
  } catch (error) {
    api.unlockFileEx(handle, 0, 1, 0, overlapped);
    api.closeHandle(handle);
    throw error;
  }
  if (api.unlockFileEx(handle, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError();
    api.closeHandle(handle);
    throwWin32(api, 'UnlockFileEx', win32Code, lockPath);
  }
  if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', `lock file ${lockPath}`);
  return result;
}

// ---- DACL grant/revoke (idempotent exact-ACE skip) ----

function buildExplicitAccess(sidPtr: NativePtr, mode: number, permissions: number): Buffer {
  const entry = Buffer.alloc(48);
  entry.writeUInt32LE(permissions, 0);
  entry.writeUInt32LE(mode, 4);
  entry.writeUInt32LE(SUB_CONTAINERS_AND_OBJECTS_INHERIT, 8);
  entry.writeUInt32LE(NO_MULTIPLE_TRUSTEE, 24);
  entry.writeUInt32LE(TRUSTEE_IS_SID, 28);
  entry.writeUInt32LE(TRUSTEE_IS_UNKNOWN, 32);
  entry.writeBigUInt64LE(ptrAddress(sidPtr), 40);
  return entry;
}

function readCurrentDacl(api: Win32Bindings, dir: string): { oldAcl: NativePtr | null; descriptor: NativePtr | null } {
  const ownerSlot = allocPtrSlot();
  const groupSlot = allocPtrSlot();
  const daclSlot = allocPtrSlot();
  const saclSlot = allocPtrSlot();
  const descriptorSlot = allocPtrSlot();
  const readResult = api.getNamedSecurityInfoW(dir, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot);
  if (readResult !== ERROR_SUCCESS) throwWin32(api, 'GetNamedSecurityInfoW', readResult, dir);
  return { oldAcl: decodePtr(daclSlot), descriptor: decodePtr(descriptorSlot) };
}

function mergeAndApply(api: Win32Bindings, dir: string, entry: Buffer, oldAcl: NativePtr | null, descriptor: NativePtr | null, label: string): void {
  const newAclSlot = allocPtrSlot();
  const mergeResult = api.setEntriesInAclW(1, entry, oldAcl, newAclSlot);
  if (mergeResult !== ERROR_SUCCESS) {
    if (descriptor !== null) api.localFree(descriptor);
    throwWin32(api, 'SetEntriesInAclW', mergeResult, `${label}(${dir})`);
  }
  const newAcl = decodePtr(newAclSlot);
  if (newAcl === null) {
    if (descriptor !== null) api.localFree(descriptor);
    throwWin32(api, 'SetEntriesInAclW', api.getLastError(), `${label}(${dir}): null new ACL`);
  }
  if (descriptor !== null) api.localFree(descriptor);
  const applyResult = api.setNamedSecurityInfoW(dir, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null, null, newAcl, null);
  api.localFree(newAcl);
  if (applyResult !== ERROR_SUCCESS) throwWin32(api, 'SetNamedSecurityInfoW', applyResult, `${label}(${dir})`);
}

function hasExactGrant(oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  const aclSize = decodeUint16At(oldAcl, 2);
  const aceCount = decodeUint16At(oldAcl, 4);
  if (aclSize < 8 || aclSize > 1_048_576) return false;
  let offset = 8;
  for (let index = 0; index < aceCount; index++) {
    const aceSize = decodeUint16At(oldAcl, offset + 2);
    if (aceSize < 8 || offset + aceSize > aclSize) return false;
    const exact = decodeUint8At(oldAcl, offset) === ACCESS_ALLOWED_ACE_TYPE
      && decodeUint8At(oldAcl, offset + 1) === SUB_CONTAINERS_AND_OBJECTS_INHERIT
      && decodeUint32At(oldAcl, offset + 4) === GRANT_MASK;
    if (exact && sameSidAt(oldAcl, offset + 8, sidPtr, 0)) return true;
    offset += aceSize;
  }
  return false;
}

/**
 * Grant GRANT_MASK (Write+Delete) to the SID on `dir`, OI|CI. Idempotent: an
 * already-standing exact ACE skips SetNamedSecurityInfoW (it would eagerly
 * re-propagate across the whole tree — minutes on large workspaces).
 */
export function grantWrite(api: Win32Bindings, dir: string, sidPtr: NativePtr): void {
  withPathLock(api, dir, () => {
    const { oldAcl, descriptor } = readCurrentDacl(api, dir);
    if (oldAcl !== null && hasExactGrant(oldAcl, sidPtr)) {
      if (descriptor !== null) api.localFree(descriptor);
      return;
    }
    mergeAndApply(api, dir, buildExplicitAccess(sidPtr, GRANT_ACCESS, GRANT_MASK), oldAcl, descriptor, 'grantWrite');
  });
}

/** Remove every ACE for the SID from the directory DACL. */
export function revokeWrite(api: Win32Bindings, dir: string, sidPtr: NativePtr): void {
  withPathLock(api, dir, () => {
    const { oldAcl, descriptor } = readCurrentDacl(api, dir);
    if (oldAcl === null) {
      if (descriptor !== null) api.localFree(descriptor);
      return;
    }
    mergeAndApply(api, dir, buildExplicitAccess(sidPtr, REVOKE_ACCESS, 0), oldAcl, descriptor, 'revokeWrite');
  });
}

// ---- restricted token ----

export function openCurrentProcessToken(api: Win32Bindings): NativePtr {
  const processHandle = api.openProcess(PROCESS_QUERY_INFORMATION, 0, process.pid);
  if (isNullPtr(processHandle)) throwLastError(api, 'OpenProcess', `pid ${process.pid}`);
  const tokenSlot = allocPtrSlot();
  let token: NativePtr | null = null, processClosed = false;
  try {
    if (!api.openProcessToken(processHandle, TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY, tokenSlot)) throwLastError(api, 'OpenProcessToken');
    token = decodePtr(tokenSlot);
    if (token === null) throwLastError(api, 'OpenProcessToken', 'null token handle');
    if (!api.closeHandle(processHandle)) throwLastError(api, 'CloseHandle', 'OpenProcess process handle');
    processClosed = true;
    return token;
  } catch (error) {
    if (token !== null) { try { api.closeHandle(token); } catch { /* unwind token */ } }
    throw error;
  } finally {
    koffi.free(tokenSlot);
    if (!processClosed) { try { api.closeHandle(processHandle); } catch { /* unwind process query handle */ } }
  }
}

function findLogonSid(api: Win32Bindings, token: NativePtr): NativePtr {
  const neededSlot = allocUint32();
  api.getTokenInformation(token, TokenGroups, null, 0, neededSlot);
  const needed = decodeUint32(neededSlot);
  if (needed === 0) throwLastError(api, 'GetTokenInformation', 'TokenGroups size query');
  if (needed < TOKEN_GROUPS_OFFSET) throwWin32(api, 'GetTokenInformation', api.getLastError(), `implausible TokenGroups size ${needed}`);
  const groups = Buffer.alloc(needed);
  if (api.getTokenInformation(token, TokenGroups, groups, groups.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenGroups');
  }
  const groupCount = groups.readUInt32LE(0);
  for (let index = 0; index < groupCount; index++) {
    const sidPtr = decodePtrAt(groups, TOKEN_GROUPS_OFFSET + index * SID_AND_ATTRIBUTES_SIZE);
    const attributes = groups.readUInt32LE(TOKEN_GROUPS_OFFSET + index * SID_AND_ATTRIBUTES_SIZE + 8);
    const isLogonId = ((attributes & SE_GROUP_LOGON_ID) >>> 0) === (SE_GROUP_LOGON_ID >>> 0);
    if (sidPtr === null || !isLogonId) continue;
    const sidLength = api.getLengthSid(sidPtr);
    if (sidLength === 0) throwLastError(api, 'GetLengthSid', `logon SID group ${index}`);
    const copy = allocBytes(sidLength);
    if (api.copySid(sidLength, copy, sidPtr) === 0) throwLastError(api, 'CopySid', `logon SID group ${index}`);
    return copy;
  }
  throw new Error(`CreateRestrictedToken prerequisite failed: no logon SID among ${groupCount} groups`);
}

function makeWellKnownSid(api: Win32Bindings, type: number): NativePtr {
  const sid = allocBytes(SECURITY_MAX_SID_SIZE);
  const sizeSlot = allocUint32();
  encodeUint32(sizeSlot, SECURITY_MAX_SID_SIZE);
  if (api.createWellKnownSid(type, null, sid, sizeSlot) === 0) throwLastError(api, 'CreateWellKnownSid', `type ${type}`);
  if (api.isValidSid(sid) === 0) throwLastError(api, 'IsValidSid', `CreateWellKnownSid type ${type}`);
  return sid;
}

/** Merge a full-access allow ACE for `sidPtr` into the token's DEFAULT DACL. */
function setTokenDefaultDaclGrant(api: Win32Bindings, token: NativePtr, sidPtr: NativePtr): void {
  const neededSlot = allocUint32();
  api.getTokenInformation(token, TokenDefaultDacl, null, 0, neededSlot);
  const needed = decodeUint32(neededSlot);
  if (needed === 0) throwLastError(api, 'GetTokenInformation', 'TokenDefaultDacl size query');
  const buffer = Buffer.alloc(needed);
  if (api.getTokenInformation(token, TokenDefaultDacl, buffer, buffer.length, neededSlot) === 0) {
    throwLastError(api, 'GetTokenInformation', 'TokenDefaultDacl');
  }
  const currentDacl = decodePtrAt(buffer, 0);
  if (currentDacl === null) throw new Error('token carries no default DACL to extend');
  const newDaclSlot = allocPtrSlot();
  const result = api.setEntriesInAclW(1, buildExplicitAccess(sidPtr, GRANT_ACCESS, FILE_ALL_ACCESS), currentDacl, newDaclSlot);
  if (result !== ERROR_SUCCESS) throwWin32(api, 'SetEntriesInAclW', result, 'default DACL merge');
  const newDacl = decodePtr(newDaclSlot);
  if (newDacl === null) throwWin32(api, 'SetEntriesInAclW', result, 'null merged default DACL');
  const info = Buffer.alloc(8);
  info.writeBigUInt64LE(newDacl, 0);
  if (api.setTokenInformation(token, TokenDefaultDacl, info, info.length) === 0) {
    const win32Code = api.getLastError();
    api.localFree(newDacl);
    throwWin32(api, 'SetTokenInformation', win32Code, 'TokenDefaultDacl');
  }
  api.localFree(newDacl);
}

function parseSid(api: Win32Bindings, sid: string): NativePtr {
  const sidSlot = allocPtrSlot();
  if (api.convertStringSidToSidW(sid, sidSlot) === 0) throwLastError(api, 'ConvertStringSidToSidW', sid);
  const parsed = decodePtr(sidSlot);
  if (parsed === null) throwLastError(api, 'ConvertStringSidToSidW', `null SID for ${sid}`);
  return parsed;
}

/** Pack SID_AND_ATTRIBUTES[count] (16-byte stride; Attributes stay 0). */
function buildRestrictingSids(sids: readonly NativePtr[]): Buffer {
  const buffer = Buffer.alloc(SID_AND_ATTRIBUTES_SIZE * sids.length);
  sids.forEach((sid, index) => {
    buffer.writeBigUInt64LE(ptrAddress(sid), SID_AND_ATTRIBUTES_SIZE * index);
  });
  return buffer;
}

// ---- confined spawn ----

/** Quote one argv entry per CommandLineToArgvW rules. */
export function quoteArg(argument: string): string {
  if (argument === '') return '""';
  if (!/[\s"]/u.test(argument)) return argument;
  let quoted = '"';
  for (let index = 0; index < argument.length; index++) {
    let backslashes = 0;
    while (index < argument.length && argument.charAt(index) === '\\') {
      backslashes++;
      index++;
    }
    if (index === argument.length) {
      quoted += '\\'.repeat(backslashes * 2);
    } else if (argument.charAt(index) === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      quoted += '\\'.repeat(backslashes) + argument.charAt(index);
    }
  }
  return quoted + '"';
}

function createPipe(api: Win32Bindings): { read: NativePtr; write: NativePtr } {
  const readSlot = allocPtrSlot(), writeSlot = allocPtrSlot();
  let read: NativePtr | null = null, write: NativePtr | null = null;
  try {
    if (!api.createPipe(readSlot, writeSlot, null, 0)) throwLastError(api, 'CreatePipe');
    read = decodePtr(readSlot); write = decodePtr(writeSlot);
    if (read === null || write === null) throwLastError(api, 'CreatePipe', 'null pipe handle');
    return { read, write };
  } catch (error) {
    for (const handle of [read, write]) if (handle !== null) { try { api.closeHandle(handle); } catch { /* unwind partial pipe */ } }
    throw error;
  } finally { koffi.free(readSlot); koffi.free(writeSlot); }
}

function setInheritable(api: Win32Bindings, handle: NativePtr, label: string): void {
  if (api.setHandleInformation(handle, 0x1, 0x1) === 0) throwLastError(api, 'SetHandleInformation', label);
}

/** A confined child with piped stdio: pid, process handle, pipe read ends. */
export interface SpawnedNative {
  pid: number;
  process: NativePtr;
  stdoutRead: NativePtr;
  stderrRead: NativePtr;
  /** stdin write end kept open by the host (write commands, close on EOF). */
  stdinWrite: NativePtr;
  job: NativePtr;
}

/**
 * Create a confined child with piped stdio under the restricted token, placed
 * in a kill-on-close job (dies with the daemon). CREATE_SUSPENDED so job
 * assignment precedes any code execution. stdin pipe write end is returned to
 * the host (the persistent shell writes commands into it).
 */
export interface NativeSpawnOptions { command: string; args: readonly string[]; cwd: string; creationFlags?: number; env?: Record<string, string> }

export function encodeEnvironment(env: Record<string, string>): Buffer {
  const keys = Object.keys(env).sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase(), 'en'));
  const seen = new Set<string>();
  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || env[key]!.includes('\0') || seen.has(key.toUpperCase())) throw new Error('invalid process environment');
    seen.add(key.toUpperCase());
  }
  return Buffer.from(keys.map(key => `${key}=${env[key]}`).join('\0') + '\0\0', 'utf16le');
}

export function spawnSandboxed(api: Win32Bindings, token: NativePtr, options: NativeSpawnOptions): SpawnedNative {
  const environment = options.env === undefined ? null : encodeEnvironment(options.env);
  const handles = new Set<NativePtr>(), allocations: NativePtr[] = [];
  let child: NativePtr | null = null;
  const own = (h: NativePtr): NativePtr => { if (!isNullPtr(h)) handles.add(h); return h; };
  const close = (h: NativePtr) => { if (!api.closeHandle(h)) throwLastError(api, 'CloseHandle'); handles.delete(h); };
  const pipe = () => { const p = createPipe(api); own(p.read); own(p.write); return p; };
  try {
    const job = own(api.createJobObjectW(null, null));
    if (isNullPtr(job)) throwLastError(api, 'CreateJobObjectW');
    const info = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_SIZE);
    info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET);
    if (!api.setInformationJobObject(job, JobObjectExtendedLimitInformation, info, info.length)) throwLastError(api, 'SetInformationJobObject');
    const stdIn = pipe(), stdOut = pipe(), stdErr = pipe();
    setInheritable(api, stdIn.read, 'stdin read end');
    setInheritable(api, stdOut.write, 'stdout write end');
    setInheritable(api, stdErr.write, 'stderr write end');
    const startupInfo = allocStartupInfo(); allocations.push(startupInfo);
    const processInfo = allocProcessInfo(); allocations.push(processInfo);
    encodeStartupInfo(startupInfo, { cb: STARTUPINFOW_SIZE, dwFlags: STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, wShowWindow: SW_HIDE,
      hStdInput: stdIn.read, hStdOutput: stdOut.write, hStdError: stdErr.write });
    const commandLine = [options.command, ...options.args].map(quoteArg).join(' ');
    // Assign the independent kill-on-close Job BEFORE executing any child code.
    // CREATE_UNICODE_ENVIRONMENT is required for an explicit UTF-16 environment block.
    if (!api.createProcessAsUserW(token, null, commandLine, null, null, 1,
      // WRITE_RESTRICTED children must inherit the console. CREATE_NO_WINDOW
      // (and CREATE_NEW_CONSOLE) can die with STATUS_DLL_INIT_FAILED before the
      // shell starts; SW_HIDE above controls appearance without isolating it.
      CREATE_SUSPENDED | (environment ? 0x400 : 0) | (options.creationFlags ?? 0), environment, options.cwd, startupInfo, processInfo)) {
      throwLastError(api, 'CreateProcessAsUserW', `command: ${options.command}, cwd: ${options.cwd}`);
    }
    const decoded = decodeProcessInfo(processInfo);
    child = decoded.hProcess;
    if (child !== null) own(child);
    if (decoded.hThread !== null) own(decoded.hThread);
    if (child === null || decoded.hThread === null) throw new Error('CreateProcessAsUserW returned null handles');
    if (!api.assignProcessToJobObject(job, child)) throwLastError(api, 'AssignProcessToJobObject');
    if (api.resumeThread(decoded.hThread) === 0xffffffff) throwLastError(api, 'ResumeThread');
    close(decoded.hThread); close(stdIn.read); close(stdOut.write); close(stdErr.write);
    const result = { pid: decoded.dwProcessId, process: child, stdoutRead: stdOut.read, stderrRead: stdErr.read, stdinWrite: stdIn.write, job };
    handles.clear(); // transfer ownership to caller only after all setup steps succeed
    return result;
  } catch (error) {
    if (child !== null) { try { api.terminateProcess(child, 1); } catch { /* Job close also terminates descendants */ } }
    throw error;
  } finally {
    for (const h of handles) { try { api.closeHandle(h); } catch { /* unwind all handles */ } }
    for (const p of allocations) koffi.free(p);
  }
}

/**
 * Stream one pipe read end via PeekNamedPipe polling, invoking `onChunk` per
 * data slice; resolves at EOF (child closed its end) and closes the handle.
 * A `killed` flag through `stop()` ends the poll loop early (kill path).
 */
export function streamPipe(api: Win32Bindings, handle: NativePtr, onChunk: (chunk: Buffer) => void): { done: Promise<void>; stop: () => void } {
  let stopped = false;
  const done = (async () => {
    const bytesReadSlot = allocUint32(), totalAvailSlot = allocUint32(), leftThisMessageSlot = allocUint32();
    try {
      for (;;) {
        if (stopped) break;
        const peeked = api.peekNamedPipe(handle, null, 0, bytesReadSlot, totalAvailSlot, leftThisMessageSlot);
        if (peeked === 0) {
          const win32Code = api.getLastError();
          if (win32Code === ERROR_BROKEN_PIPE || win32Code === ERROR_NO_DATA) break;
          throw new Error(`PeekNamedPipe failed (${win32Code})`);
        }
        const available = decodeUint32(totalAvailSlot);
        if (available > 0) {
          const chunk = Buffer.alloc(Math.min(available, 64 * 1024));
          if (api.readFile(handle, chunk, chunk.length, bytesReadSlot, null) === 0) throw new Error(`ReadFile failed (${api.getLastError()})`);
          onChunk(chunk.subarray(0, decodeUint32(bytesReadSlot)));
        }
        await new Promise<void>((resolve) => setTimeout(resolve, available > 0 ? 1 : 10));
      }
    } finally {
      for (const slot of [bytesReadSlot, totalAvailSlot, leftThisMessageSlot]) koffi.free(slot);
      try { api.closeHandle(handle); } catch { /* best effort */ }
    }
  })();
  return { done, stop: () => { stopped = true; } };
}

/**
 * Wait for exit (SYNCHRONOUS — call only after the pipe streams ended, i.e.
 * the child closed its ends and has exited). Closes the process handle.
 */
export function waitForExit(api: Win32Bindings, process: NativePtr): number {
  const waitResult = api.waitForSingleObject(process, INFINITE);
  if (waitResult === 0xffffffff) throwLastError(api, 'WaitForSingleObject');
  const exitCodeSlot = allocUint32();
  if (api.getExitCodeProcess(process, exitCodeSlot) === 0) throwLastError(api, 'GetExitCodeProcess');
  api.closeHandle(process);
  return decodeUint32(exitCodeSlot);
}

// ---- the sandbox instance ----

export interface AclSandboxOptions {
  /** The file-effect mode; selects the restricting-SID list and grant shape. */
  mode: 'read-only' | 'workspace-write';
  /** Canonical workspace root (must exist and be caller-owned). */
  workspaceRoot: string;
  /**
   * M4.6 writableDirs：operator 额外授予的内核写目录（canonical、必须已存在）。
   * 每个目录按路径哈希派生独立 SID（与 workspace 同机制），grant 也是常驻 ACE。
   */
  extraWritableDirs?: readonly string[];
  /**
   * Per-session private temp directory; created by the sandbox when omitted
   * under the OS temp root (always OUTSIDE the workspace). Pass null under
   * workspace-write to disable temp writes.
   */
  tempDir?: string | null;
}

/** One confined-spawn context: restricted token + grants. */
export class AclSandbox {
  readonly mode: 'read-only' | 'workspace-write';
  readonly workspaceRoot: string;
  /** The session's private temp dir (null when temp writes are disabled). */
  tempDir: string | null = null;
  private api: Win32Bindings | undefined;
  private token: NativePtr | undefined;
  private writeSidPtr: NativePtr | undefined;
  private tempSidPtr: NativePtr | undefined;
  /** M4.6 writableDirs 的 SID（与目录一一对应；dispose 时只 free 句柄，ACE 常驻）。 */
  private extraSidPtrs: NativePtr[] = [];
  private keepAlive: SidSet | undefined;
  private ownTempDir = false;

  constructor(private readonly options: AclSandboxOptions) {
    this.mode = options.mode;
    this.workspaceRoot = options.workspaceRoot;
  }

  /** Build the restricted token and materialize the grants. Fail-closed. */
  init(): void {
    if (this.api !== undefined) throw new Error('AclSandbox is already initialized');
    const api = win32();
    const currentToken = openCurrentProcessToken(api);
    let currentTokenOpen = true;
    try {
      let tempDir: string | null;
      if (this.mode === 'read-only' || this.options.tempDir === null) {
        tempDir = null;
      } else if (this.options.tempDir === undefined) {
        // private per-session temp under the OS temp root, never the ambient
        // root itself and never inside the workspace
        const base = join(tmpdir(), 'bh-sandbox');
        mkdirSync(base, { recursive: true });
        const baseReal = realpathSync.native(base);
        if (containsDirectory(this.workspaceRoot, baseReal)) {
          throw new Error('sandbox temp root overlaps the workspace; set BLACKHOLE_SANDBOX_TMP outside it');
        }
        tempDir = mkdtempSync(join(baseReal, 's-'));
        this.ownTempDir = true;
      } else {
        tempDir = resolve(this.options.tempDir);
        if (!existsSync(tempDir) || !statSync(tempDir).isDirectory()) {
          throw new Error(`sandbox temp dir does not exist or is not a directory: ${tempDir}`);
        }
      }
      if (tempDir !== null) assertTempDisjoint([this.workspaceRoot, ...(this.options.extraWritableDirs ?? [])], tempDir);
      this.tempDir = tempDir;

      const canonicalRoot = realpathSync.native(this.workspaceRoot);
      this.writeSidPtr = this.mode === 'workspace-write' ? parseSid(api, workspaceWriteSid(canonicalRoot)) : undefined;
      this.tempSidPtr = tempDir !== null ? parseSid(api, tempWriteSid(tempDir)) : undefined;

      if (this.writeSidPtr !== undefined) {
        // STANDING grant on the workspace (reuse cache across sessions — the
        // exact-ACE skip makes later provisions O(1)); revoking would force a
        // full tree re-propagation on the next session.
        grantWrite(api, canonicalRoot, this.writeSidPtr);
      }
      // M4.6 writableDirs：同一套 workspace 机制，每个目录独立哈希 SID + 常驻 ACE
      // （仅 workspace-write 授予；read-only 的 restricting 列表不含任何写 SID）
      for (const dir of this.mode === 'workspace-write' ? this.options.extraWritableDirs ?? [] : []) {
        const canonical = realpathSync.native(dir);
        const sid = parseSid(api, workspaceWriteSid(canonical));
        grantWrite(api, canonical, sid);
        this.extraSidPtrs.push(sid);
      }
      if (tempDir !== null && this.tempSidPtr !== undefined) {
        grantWrite(api, tempDir, this.tempSidPtr);
      }

      const logonSid = findLogonSid(api, currentToken);
      const worldSid = makeWellKnownSid(api, WinWorldSid);
      this.keepAlive = { logon: logonSid, world: worldSid };

      const writeSids = [this.writeSidPtr, ...this.extraSidPtrs, this.tempSidPtr].filter((sid): sid is NativePtr => sid !== undefined);
      const restricting = this.mode === 'read-only'
        ? [logonSid, worldSid]
        : [logonSid, worldSid, ...writeSids];
      const restrictingBuffer = buildRestrictingSids(restricting);
      const tokenSlot = allocPtrSlot();
      const created = api.createRestrictedToken(
        currentToken,
        0x1 | 0x4 | 0x8, // DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED
        0, null,
        0, null,
        restricting.length,
        restrictingBuffer,
        tokenSlot,
      );
      if (created === 0) throwLastError(api, 'CreateRestrictedToken', `restricting SIDs: ${restricting.length}`);
      const token = decodePtr(tokenSlot);
      if (token === null) throwWin32(api, 'CreateRestrictedToken', api.getLastError(), 'null token handle');
      // default-DACL grant for a restricting SID: new objects (pipes) the
      // child creates pass the write pass-2 at creation
      // Logon SID participates in BOTH normal and restricting access checks.
      // Capability-only grants fail with admin/service default DACLs. This affects
      // new private objects only; no existing filesystem ACL or token is relaxed.
      setTokenDefaultDaclGrant(api, token, logonSid);
      this.token = token;
      // api is set BEFORE any operation that can throw past this point in the
      // try: the catch's cleanup needs it to free the SIDs/revoke the grants
      // this constructor already applied.
      this.api = api;
      if (api.closeHandle(currentToken) === 0) throwLastError(api, 'CloseHandle', 'current process token');
      currentTokenOpen = false;
    } catch (error) {
      if (currentTokenOpen) {
        try { api.closeHandle(currentToken); } catch { /* best-effort on the failure path */ }
      }
      // failures BEFORE this.api was assigned still allocated the temp dir
      // and (on post-grant failures) applied ACEs — clean those with the
      // LOCAL api binding, not the (still undefined) field.
      this.disposeBestEffort(api);
      throw error;
    }
  }

  private disposeBestEffort(api?: Win32Bindings): void {
    const bindings = api ?? this.api;
    if (bindings === undefined) {
      // nothing reached the FFI layer except possibly the temp dir
      if (this.ownTempDir && this.tempDir) {
        try { rmSync(this.tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      return;
    }
    if (this.tempDir !== null && this.tempSidPtr !== undefined) {
      try { revokeWrite(bindings, this.tempDir, this.tempSidPtr); } catch { /* best effort */ }
    }
    for (const sid of [this.writeSidPtr, ...this.extraSidPtrs, this.tempSidPtr, this.keepAlive?.logon, this.keepAlive?.world]) {
      if (sid === undefined) continue;
      try { bindings.localFree(sid); } catch { /* best effort */ }
    }
    if (this.token !== undefined) {
      try { bindings.closeHandle(this.token); } catch { /* best effort */ }
    }
    if (this.ownTempDir && this.tempDir) {
      try { rmSync(this.tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    this.token = undefined;
    this.writeSidPtr = undefined;
    this.tempSidPtr = undefined;
    this.extraSidPtrs = [];
    this.keepAlive = undefined;
    this.api = undefined;
  }

  /** Revoke the revocable (temp) grant, free everything. Standing workspace ACE stays. */
  dispose(): void {
    this.disposeBestEffort();
  }

  /**
   * Spawn one confined process (piped stdio). Fails closed: any Win32
   * failure throws and no child is left running. Existing shells omit env and
   * inherit as before; managed background processes pass an explicit UTF-16
   * environment Buffer so NUL separators are not truncated by FFI string encoding.
   */
  spawn(options: NativeSpawnOptions): SpawnedNative {
    const api = this.api;
    const token = this.token;
    if (api === undefined || token === undefined) throw new Error('AclSandbox is not initialized: call init() first');
    return spawnSandboxed(api, token, options);
  }

  get tempWriteSidString(): string | null {
    return this.tempDir !== null ? tempWriteSid(this.tempDir) : null;
  }
}

/**
 * Remove orphaned private temp dirs left by crashed/killed daemon lifetimes
 * (a hard kill never reaches dispose). Each dir's temp SID is random — a
 * leftover ACE is inert — so this is litter collection, not a security fix.
 * `exclude` names the LIVE private temp dirs this daemon still owns.
 */
export function cleanupOrphanSandboxTemps(exclude: readonly string[]): void {
  const base = join(tmpdir(), 'bh-sandbox');
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return; // nothing to clean
  }
  const kept = new Set(exclude.map((dir) => resolve(dir).toLowerCase()));
  for (const name of entries) {
    if (!name.startsWith('s-')) continue;
    const dir = join(base, name);
    if (kept.has(resolve(dir).toLowerCase())) continue;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* another process may hold it */ }
  }
}
