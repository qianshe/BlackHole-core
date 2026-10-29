import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey } from 'node:crypto';
import { CoreBootstrapSchema, HostCoreBuildSchema, type CoreBootstrap } from '../../contracts/src/core-bootstrap.js';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function regular(file: string, max: number): Buffer {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw Error('host_core_file_invalid');
  const raw = fs.readFileSync(file);
  if (raw.length !== info.size) throw Error('host_core_file_changed');
  return raw;
}
function pinned(root: string, relative: string, hash: string, max: number): Buffer {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw Error('host_core_link_rejected');
  }
  const bytes = regular(current, max);
  if (digest(bytes) !== hash) throw Error('host_core_build_integrity_failed');
  return bytes;
}
export function loadHostCoreBuild(extensionRoot: string, input: unknown, cloud: { environment: string; origin: string }, platform = process.platform, arch = process.arch): CoreBootstrap {
  const build = HostCoreBuildSchema.parse(input);
  if (build.platform !== platform || build.arch !== arch) throw Error('shared_core_platform_unsupported');
  const reference = CoreBootstrapSchema.parse(JSON.parse(pinned(extensionRoot, 'dist/manager/core-bootstrap.json', build.bootstrapSha256, 32 * 1024).toString('utf8')));
  pinned(extensionRoot, 'dist/manager/core-manager-cli.mjs', build.managerSha256, 8 * 1024 * 1024);
  const trust = JSON.parse(pinned(extensionRoot, 'dist/manager/trust.json', build.trustSha256, 64 * 1024).toString('utf8'));
  if (reference.environment !== cloud.environment || reference.cloudOrigin !== cloud.origin || reference.platform !== platform || reference.arch !== arch
    || trust.environment !== cloud.environment || !trust.publicKeys || Object.keys(trust).sort().join(',') !== 'environment,publicKeys'
    || Object.keys(trust.publicKeys).length < 1 || Object.keys(trust.publicKeys).length > 8) throw Error('host_core_trust_mismatch');
  for (const [id, value] of Object.entries(trust.publicKeys)) {
    if (typeof value !== 'string' || value.length > 4096 || (cloud.environment === 'production' && /^test[-_]/i.test(id))
      || createPublicKey(value).asymmetricKeyType !== 'ed25519') throw Error('host_core_trust_invalid');
  }
  return reference;
}

function ensureDirectoryTree(root: string): void {
  if (!path.isAbsolute(root)) throw Error('core_download_directory_invalid');
  const parent = path.dirname(root);
  if (parent !== root) ensureDirectoryTree(parent);
  // Windows may return EPERM rather than EEXIST for mkdir('C:\\').
  // Inspect existing ancestors without trying to create them; still reject
  // links/non-directories at every level and recheck a creation race.
  let stat: fs.Stats;
  try { stat = fs.lstatSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { fs.mkdirSync(root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    stat = fs.lstatSync(root);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('core_download_link_rejected');
}
export function coreRedirectAllowed(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.port
      && ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(u.hostname);
  } catch { return false; }
}
export type CoreDownloadOptions = {
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
  /** Dependency injection for isolated transport tests, never from product settings. */
  fetcher?: typeof fetch;
};

/** No Node download, shell command or daemon mutation. Manager must independently
 * verify the signed Core and exact pinned archive after this function returns. */
export async function acquireHostCore(referenceInput: CoreBootstrap, extensionRoot: string, updatesRoot: string, options: CoreDownloadOptions = {}): Promise<{ archive: string; cleanup: () => void }> {
  const reference = CoreBootstrapSchema.parse(referenceInput);
  options.signal?.throwIfAborted();
  if (reference.source.kind === 'embedded') {
    const archive = path.join(extensionRoot, 'dist/core/core.zip');
    const raw = pinned(extensionRoot, 'dist/core/core.zip', reference.archiveHash, reference.archiveBytes);
    if (raw.length !== reference.archiveBytes) throw Error('core_archive_size_mismatch');
    return { archive, cleanup() {} };
  }
  ensureDirectoryTree(updatesRoot);
  const dir = fs.mkdtempSync(path.join(updatesRoot, 'core-download-'));
  const archive = path.join(dir, 'core.zip');
  const partial = path.join(dir, 'core.partial');
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(cancel, 5 * 60_000);
  const fetcher = options.fetcher ?? fetch;
  let body: ReadableStream<Uint8Array> | null = null;
  let fd: number | undefined;
  try {
    let url = reference.source.url;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      controller.signal.throwIfAborted();
      if (!coreRedirectAllowed(url)) throw Error('core_download_redirect_rejected');
      response = await fetcher(url, { signal: controller.signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: 'application/octet-stream' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw Error('core_download_redirect_rejected');
      url = new URL(location, url).href;
    }
    if (!response || response.status !== 200 || !response.body) throw Error('core_download_unavailable');
    body = response.body;
    const length = response.headers.get('content-length');
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) !== reference.archiveBytes)) throw Error('core_archive_size_mismatch');
    fd = fs.openSync(partial, 'wx', 0o600);
    const hash = createHash('sha256');
    const reader = body.getReader();
    let received = 0;
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > reference.archiveBytes) throw Error('core_archive_size_mismatch');
        hash.update(value);
        let offset = 0;
        while (offset < value.length) offset += fs.writeSync(fd, value, offset);
        options.onProgress?.(received, reference.archiveBytes);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    controller.signal.throwIfAborted();
    if (received !== reference.archiveBytes || hash.digest('hex') !== reference.archiveHash) throw Error('core_archive_integrity_failed');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(partial, archive);
    return { archive, cleanup };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    await body?.cancel().catch(() => {});
    cleanup();
    if (controller.signal.aborted) throw Error('core_download_cancelled');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
