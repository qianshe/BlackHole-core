import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

// Pinned official OpenAI tunnel-client *runtime* flavor (never the
// runtime-cloudflared or full CLI archives). Every listed target is required
// to pass the native OpenAI runtime CI matrix before merge. Never a runtime
// lookup of "latest": https://github.com/openai/tunnel-client/releases/tag/v0.0.15
const VERSION = 'v0.0.15';
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXE_BYTES = 128 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['persistent.oaistatic.com', 'github.com', 'release-assets.githubusercontent.com']);
const SOURCES = [
  (asset: string) => `https://persistent.oaistatic.com/tunnel-client/${VERSION}/${asset}`,
  (asset: string) => `https://github.com/openai/tunnel-client/releases/download/${VERSION}/${asset}`,
];

interface Artifact { asset: string; size: number; archiveSha256: string; exe: string; exeSha256: string }
const ARTIFACTS: Record<string, Artifact> = {
  'win32-x64': {
    asset: 'tunnel-client-runtime-v0.0.15-windows-amd64.zip',
    size: 7523198,
    archiveSha256: 'aa5ddb14dddd602fa59f3e6f4401aa8a79a218e341466226b7434127dff65dbc',
    exe: 'tunnel-client-runtime.exe',
    exeSha256: 'a922d372d6be0649156fbc1c8a040597f1f4bb5b4356890151d7875602593b1a',
  },
  'win32-arm64': {
    asset: 'tunnel-client-runtime-v0.0.15-windows-arm64.zip',
    size: 6684018,
    archiveSha256: '3c610dd27760987b11285670b35faa36fec8460e68d64a4cdda4342ce6b8e8be',
    exe: 'tunnel-client-runtime.exe',
    exeSha256: 'ec9eb30f9ca6f28c00215d07456dde25890ffa776fc8842a270add9c3d984240',
  },
  'darwin-x64': {
    asset: 'tunnel-client-runtime-v0.0.15-darwin-amd64.zip',
    size: 7540502,
    archiveSha256: '2d3a2b3a985ad2fcfddc4a82a0caa6624ee9383e7d85e82563bf1fe3ce905794',
    exe: 'tunnel-client-runtime',
    exeSha256: 'e17ffc98dce25a31c22714875267eeb309abdb35bea450c5801272317559f033',
  },
  'darwin-arm64': {
    asset: 'tunnel-client-runtime-v0.0.15-darwin-arm64.zip',
    size: 6938206,
    archiveSha256: 'e416ea9ea13e1b8be0d0a355fbd28143cfa55fe5a32b2986fce1a516d7b5e2ad',
    exe: 'tunnel-client-runtime',
    exeSha256: 'fcc8e40de0606b8909c7ee44a0816d33d616949389ff37938e2657c7a2333025',
  },
  'linux-x64': {
    asset: 'tunnel-client-runtime-v0.0.15-linux-amd64.zip',
    size: 7367159,
    archiveSha256: 'f26f8b3ee6c335e38fa5cfbe6ce5635f53738f08a26eecf07d6cebacab4a1abf',
    exe: 'tunnel-client-runtime',
    exeSha256: '9755c5f60f40ac64e1a71f9b7d14bc6135fb3fe7170d79c6695881d3aa1255d5',
  },
  'linux-arm64': {
    asset: 'tunnel-client-runtime-v0.0.15-linux-arm64.zip',
    size: 6620866,
    archiveSha256: 'a868d295385b22449341fa141b911f3e991583e45b1fa2a5bfb946aed1861b88',
    exe: 'tunnel-client-runtime',
    exeSha256: '08ee4ef1a1a0314d7058d37ae57eef9b1de2ce9632fc2f92798e97eb48ca0049',
  },
};
/** Extracted next to the executable; everything else in the archive is ignored. */
const SIDE_FILES = ['LICENSE', 'NOTICE'];

export type RunFile = (file: string, args: string[]) => Promise<Buffer>;
interface InstallEnvironment {
  platform: string;
  arch: string;
  pathValue: string;
  root: string;
  run: RunFile;
  fetch: typeof fetch;
}
export interface OpenAITunnelInstallResult { path: string; installed: boolean; version: string }

const runFile: RunFile = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, {
    // First run of a fresh executable can wait on antivirus scans.
    encoding: 'buffer', timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    windowsHide: true, shell: false, cwd: homedir(),
    // Nothing secret or inherited-config-driven is needed for --version/--help.
    env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? process.env.Path ?? '' },
  }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const exeName = (platform: string): string => platform === 'win32' ? 'tunnel-client-runtime.exe' : 'tunnel-client-runtime';

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Identity + capability check. `--version` must report the runtime flavor
 * (not the full CLI); `run --help` must offer the flags BlackHole drives and
 * no cloudflared companion options.
 */
async function verify(file: string, run: RunFile, expectedVersion?: string): Promise<string> {
  try {
    const version = (await run(file, ['--version'])).toString('utf8');
    const m = /^(\d+\.\d+\.\d+)\s+git sha:\s*[0-9a-f]+.*\sflavor=runtime(?:\s|$)/m.exec(version);
    if (!m) throw new Error('不是 tunnel-client 纯运行版（--version 未报告 flavor=runtime）');
    if (expectedVersion && `v${m[1]}` !== expectedVersion) throw new Error(`版本不符：${m[1]}，期望 ${expectedVersion.slice(1)}`);
    const help = (await run(file, ['run', '--help'])).toString('utf8');
    for (const flag of ['--control-plane.tunnel-id', '--control-plane.api-key', '--mcp.server-url', '--health.listen-addr', '--health.url-file']) {
      if (!help.includes(flag)) throw new Error(`缺少必需参数 ${flag}`);
    }
    if (/cloudflared/i.test(help)) throw new Error('该程序包含 cloudflared 伴随选项，不是纯运行版');
    return `v${m[1]}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw new Error(`OpenAI tunnel-client 不可用：${file}（${code ? `${code}: ` : ''}${detail}）。请重新检查路径或安装；未修改 PATH，也未下载或替换该文件。`, { cause: error });
  }
}

/** Follows at most 3 redirects, each hop https and on the allowlist. */
async function fetchPinned(url: string, fetchFile: typeof fetch): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= 3; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) throw new Error(`下载地址不在允许列表：${u.hostname}`);
    const response = await fetchFile(current, { signal: AbortSignal.timeout(120_000), redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (!next) throw new Error(`HTTP ${response.status} 缺少跳转地址`);
      current = new URL(next, current).toString();
      continue;
    }
    return response;
  }
  throw new Error('跳转次数过多');
}

async function downloadFrom(url: string, artifact: Artifact, fetchFile: typeof fetch): Promise<Buffer> {
  const response = await fetchPinned(url, fetchFile);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const limit = Math.min(artifact.size, MAX_ARCHIVE_BYTES);
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel();
    throw new Error('文件超出预期大小');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('文件超出预期大小');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  // Authenticate before any archive parsing.
  if (bytes.length !== artifact.size || sha256(bytes) !== artifact.archiveSha256) throw new Error('SHA-256 校验失败');
  return bytes;
}

async function download(artifact: Artifact, fetchFile: typeof fetch): Promise<Buffer> {
  const failures: string[] = [];
  for (const source of SOURCES) {
    const url = source(artifact.asset);
    try { return await downloadFrom(url, artifact, fetchFile); }
    catch (error) { failures.push(`${new URL(url).hostname}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  throw new Error(`OpenAI tunnel-client 下载失败，未安装或执行任何文件（${failures.join('；')}）。`);
}

interface ZipEntry { name: string; method: number; compressedSize: number; size: number; localOffset: number }

/**
 * Minimal reader for the pinned, already hash-verified archive. Rejects
 * ZIP64, encryption, directories, symlinks, path separators, `..`, duplicate
 * names and unsupported compression, so nothing outside the named files can
 * be materialized.
 */
function readZipEntries(zip: Buffer): Map<string, ZipEntry> {
  const min = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = zip.length - 22; i >= min; i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('压缩包结构无效');
  const count = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  let p = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || p === 0xffffffff || p + cdSize > eocd) throw new Error('不支持的压缩包格式');
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error('压缩包目录无效');
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const external = zip.readUInt32LE(p + 38);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    const mode = (external >>> 16) & 0o170000;
    if (flags & 0x1) throw new Error('压缩包含加密条目');
    if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.includes(':') || name.includes('\0')) throw new Error(`压缩包含不安全条目：${name}`);
    if (mode !== 0 && mode !== 0o100000) throw new Error(`压缩包含非普通文件：${name}`);
    if (method !== 0 && method !== 8) throw new Error(`不支持的压缩方式：${name}`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new Error('不支持的压缩包格式');
    if (entries.has(name.toLowerCase())) throw new Error(`压缩包含重复条目：${name}`);
    entries.set(name.toLowerCase(), { name, method, compressedSize, size, localOffset });
  }
  return entries;
}

function extract(zip: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  if (entry.size > maxBytes) throw new Error(`条目超出大小限制：${entry.name}`);
  const h = entry.localOffset;
  if (h + 30 > zip.length || zip.readUInt32LE(h) !== 0x04034b50) throw new Error('压缩包条目无效');
  const start = h + 30 + zip.readUInt16LE(h + 26) + zip.readUInt16LE(h + 28);
  const end = start + entry.compressedSize;
  if (end > zip.length) throw new Error('压缩包条目越界');
  const data = zip.subarray(start, end);
  const out = entry.method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
  if (out.length !== entry.size) throw new Error(`条目大小不符：${entry.name}`);
  return out;
}

/** Only writes a private staging directory; never replaces an existing installation. */
async function installArtifact(artifact: Artifact, target: string, env: InstallEnvironment): Promise<string> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(path.dirname(target), '.install-'));
  try {
    const zip = await download(artifact, env.fetch);
    const entries = readZipEntries(zip);
    const exeEntry = entries.get(artifact.exe.toLowerCase());
    if (!exeEntry || exeEntry.name !== artifact.exe) throw new Error('压缩包缺少预期的可执行文件');
    if ([...entries.keys()].some((n) => n.startsWith('cloudflared'))) throw new Error('压缩包包含 cloudflared，拒绝安装');
    const exe = extract(zip, exeEntry, MAX_EXE_BYTES);
    if (sha256(exe) !== artifact.exeSha256) throw new Error('可执行文件 SHA-256 校验失败，未安装或执行');
    const stagedFile = path.join(staging, exeName(env.platform));
    await writeFile(stagedFile, exe, { mode: 0o700, flag: 'wx' });
    for (const side of SIDE_FILES) {
      const e = entries.get(side.toLowerCase());
      if (e && e.name === side) await writeFile(path.join(staging, side), extract(zip, e, 1024 * 1024), { mode: 0o600, flag: 'wx' });
    }
    try { await verify(stagedFile, env.run, VERSION); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`下载的 OpenAI tunnel-client 无法运行，未完成安装。原因：${detail}`, { cause: error });
    }
    // A competing installation cannot overwrite a non-empty target directory.
    await rename(staging, target);
    return path.join(target, exeName(env.platform));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Verify-only check used before every explicit OpenAI start: never searches,
 * downloads or replaces anything. The one-click install saves the path first.
 */
export async function verifyOpenAITunnelClient(file: string, run: RunFile = runFile): Promise<string> {
  if (!path.isAbsolute(file)) throw new Error('请先在设置页一键安装 OpenAI tunnel-client，或填写可执行文件的完整路径。');
  return verify(file, run);
}

/** Called ONLY by the explicit local install button. No settings, PATH or daemon writes. */
export async function initializeOpenAITunnelClient(
  configuredPath: string,
  overrides: Partial<InstallEnvironment> = {},
): Promise<OpenAITunnelInstallResult> {
  const env: InstallEnvironment = {
    platform: process.platform,
    arch: process.arch,
    pathValue: process.env.PATH ?? process.env.Path ?? '',
    root: path.join(homedir(), '.blackhole', 'bin', 'tunnel-client-runtime'),
    run: runFile,
    fetch: globalThis.fetch,
    ...overrides,
  };
  const paths = env.platform === 'win32' ? path.win32 : path.posix;
  const exe = exeName(env.platform);
  const configured = configuredPath.trim();
  if (configured) {
    if (!paths.isAbsolute(configured)) throw new Error('请填写 OpenAI tunnel-client 可执行文件的完整路径；未修改当前配置。');
    return { path: configured, installed: false, version: await verify(configured, env.run) };
  }

  // Respect PATH order; a broken candidate is reported, never replaced.
  for (const entry of env.pathValue.split(paths.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!paths.isAbsolute(directory)) continue;
    const candidate = paths.join(directory, exe);
    if (!(await exists(candidate))) continue;
    return { path: candidate, installed: false, version: await verify(candidate, env.run) };
  }

  const artifact = ARTIFACTS[`${env.platform}-${env.arch}`];
  if (!artifact) {
    throw new Error(`当前平台 ${env.platform}-${env.arch} 不在 BlackHole 的 OpenAI tunnel-client 一键安装支持矩阵。请从 https://github.com/openai/tunnel-client/releases/tag/${VERSION} 下载 tunnel-client-runtime 纯运行版（不是 runtime-cloudflared），解压后在设置页填写可执行文件的完整路径。`);
  }
  // Filesystem locations use the host's path rules (env.platform only selects the artifact).
  const target = path.join(env.root, VERSION, `${env.platform}-${env.arch}`);
  const installed = path.join(target, exe);
  if (await exists(target)) {
    // Managed location: the file must still be exactly the pinned executable.
    const bytes = await readFile(installed).catch(() => null);
    if (!bytes || sha256(bytes) !== artifact.exeSha256) {
      throw new Error(`托管目录中的 OpenAI tunnel-client 与固定版本不一致：${installed}。未覆盖；请删除该目录后重试，或手动填写路径。`);
    }
    return { path: installed, installed: false, version: await verify(installed, env.run, VERSION) };
  }
  return { path: await installArtifact(artifact, target, env), installed: true, version: VERSION };
}
