import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// Pinned official artifacts. The SHA-256 is of the executable that gets
// installed and run — for macOS .tgz artifacts that is the extracted binary,
// not the archive container — never a runtime lookup of "latest":
// https://github.com/cloudflare/cloudflared/releases/tag/2026.9.0
const VERSION = '2026.9.0';
const MAX_BYTES = 128 * 1024 * 1024;
interface Artifact { name: string; sha256: string; archiveSha256?: string }
const ARTIFACTS: Readonly<Record<string, Artifact>> = {
  'win32-x64': { name: 'cloudflared-windows-amd64.exe', sha256: '547057326266f0e1c7d50d102dbd22ff283d740c055bd61e94f10e2c606f89af' },
  'darwin-x64': { name: 'cloudflared-darwin-amd64.tgz', sha256: '53481a9eed22fbf29cf3be7638d7c437acb423cdbe06e62639d8467b05d2f44f', archiveSha256: '8f2ecf41776d942bcc8070a56e7bafa4c5de70a1d1781110e2eb3774cca512a8' },
  'darwin-arm64': { name: 'cloudflared-darwin-arm64.tgz', sha256: '2d67b7315f96799123e19442580ce7c7616d6d7f322686fa829dd4e3fddfe715', archiveSha256: 'c0eccb3758420d1f4e46cbf2b8ecde01d9802a154232a817f25133340009fcc7' },
  'linux-x64': { name: 'cloudflared-linux-amd64', sha256: '53b7a7a5420d188758d24341294acb0d1bca54296548ac05e38811a694ac6134' },
  'linux-arm64': { name: 'cloudflared-linux-arm64', sha256: '98aca3173f73248fad6180fc75dade2d186a6e54fa807e088108cb4345de8efe' },
};

type RunFile = (file: string, args: string[]) => Promise<Buffer>;
interface InstallEnvironment {
  platform: string;
  arch: string;
  pathValue: string;
  root: string;
  run: RunFile;
  fetch: typeof fetch;
}
export interface CloudflaredInstallResult { path: string; installed: boolean }

const runFile: RunFile = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, {
    // 15s: the first run of a freshly written large executable can wait on
    // antivirus real-time scans; a too-short budget misreports it as unusable.
    encoding: 'buffer', timeout: 15_000, maxBuffer: MAX_BYTES,
    windowsHide: true, shell: false, cwd: homedir(),
  }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function verify(file: string, run: RunFile): Promise<void> {
  try {
    const output = await run(file, ['--version']);
    if (!/^cloudflared version \d+\.\d+\.\d+/m.test(output.toString('utf8'))) throw new Error('无法识别版本输出');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw new Error(`cloudflared 路径不可用：${file}（${code ? `${code}: ` : ''}${detail}）。请自行检查路径或安装；未修改 PATH，也未下载或替换该文件。`, { cause: error });
  }
}

async function download(artifact: Artifact, fetchFile: typeof fetch): Promise<Buffer> {
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${artifact.name}`;
  const response = await fetchFile(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`cloudflared 下载失败（HTTP ${response.status}），请检查网络后自行重试。`);
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body.cancel();
    throw new Error('cloudflared 下载文件超出大小限制。');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('cloudflared 下载文件超出大小限制。');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  // Authenticate the download before invoking an archive parser. GitHub's
  // asset digest covers the .tgz; the release notes cover its inner binary.
  const expected = artifact.name.endsWith('.tgz') ? artifact.archiveSha256 : artifact.sha256;
  if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error('cloudflared SHA-256 校验失败，未安装或执行下载文件。');
  }
  return bytes;
}

/** Only writes a private staging directory; never replaces an existing installation. */
async function installArtifact(artifact: Artifact, target: string, env: InstallEnvironment): Promise<string> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(path.dirname(target), '.install-'));
  const exe = env.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  try {
    let bytes = await download(artifact, env.fetch);
    if (artifact.name.endsWith('.tgz')) {
      const archive = path.join(staging, 'download.tgz');
      await writeFile(archive, bytes, { mode: 0o600, flag: 'wx' });
      // macOS ships tar. Extract only this member TO STDOUT: archive paths and
      // symlinks are never materialized, including files outside staging.
      bytes = await env.run('/usr/bin/tar', ['-xOzf', archive, 'cloudflared']);
      await rm(archive);
      // The pinned hash is the executable's own: verify the extracted bytes —
      // exactly what gets written and executed — not the archive container.
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
        throw new Error('cloudflared SHA-256 校验失败，未安装或执行下载文件。');
      }
    }
    if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('cloudflared 可执行文件大小无效。');
    const stagedFile = path.join(staging, exe);
    await writeFile(stagedFile, bytes, { mode: 0o700, flag: 'wx' });
    try { await verify(stagedFile, env.run); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`下载的 cloudflared 无法运行，未完成安装。请检查系统架构与执行权限。原因：${detail}`, { cause: error });
    }
    // A competing installation cannot overwrite a non-empty target directory.
    await rename(staging, target);
    return path.join(target, exe);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Called ONLY by the explicit local install button. No settings, PATH or daemon writes. */
export async function initializeCloudflared(
  configuredPath: string,
  overrides: Partial<InstallEnvironment> = {},
): Promise<CloudflaredInstallResult> {
  const env: InstallEnvironment = {
    platform: process.platform,
    arch: process.arch,
    pathValue: process.env.PATH ?? process.env.Path ?? '',
    root: path.join(homedir(), '.blackhole', 'bin', 'cloudflared'),
    run: runFile,
    fetch: globalThis.fetch,
    ...overrides,
  };
  const paths = env.platform === 'win32' ? path.win32 : path.posix;
  const configured = configuredPath.trim();
  if (configured) {
    if (!paths.isAbsolute(configured)) throw new Error('请填写 cloudflared 可执行文件的完整路径；未修改当前配置。');
    await verify(configured, env.run);
    return { path: configured, installed: false };
  }

  // Respect PATH order. A broken candidate is a hint, never permission to
  // search for a replacement or download one. Stop at the first usable entry.
  const exe = env.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  for (const entry of env.pathValue.split(paths.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!paths.isAbsolute(directory)) continue; // No empty/relative PATH or workspace lookup.
    const candidate = paths.join(directory, exe);
    if (!(await exists(candidate))) continue;
    await verify(candidate, env.run);
    return { path: candidate, installed: false };
  }

  const artifact = ARTIFACTS[`${env.platform}-${env.arch}`];
  if (!artifact) throw new Error(`暂不支持 ${env.platform}-${env.arch} 的一键安装，请自行安装并填写路径。`);
  const target = path.join(env.root, VERSION, `${env.platform}-${env.arch}`);
  const installed = path.join(target, exe);
  if (await exists(target)) {
    await verify(installed, env.run);
    return { path: installed, installed: false };
  }
  return { path: await installArtifact(artifact, target, env), installed: true };
}
