import fs from 'node:fs';
import { resolveDataPaths } from '../../../src/data-paths.ts';
import path from 'node:path';
import { CoreManager, StoreLockError } from './core-manager.ts';
import { CoreLifecycle } from './core-lifecycle.ts';
import { openManagedBrowser } from './core-browser.ts';
// The archive implementation is bundled into the Manager executable.
// @ts-ignore JavaScript build utility intentionally has no declaration file.
import { extractVerifiedCoreArchive } from '../../../scripts/core-runtime-lib.mjs';

const MAX_REQUEST_BYTES = 1024 * 1024;
const STARTUP_READ_WAIT_MS = 45_000;
let storeRoot: string;
try { storeRoot = resolveDataPaths().coreStore; }
catch (error) { fail('noncanonical_storage_path', error instanceof Error ? error.message : 'Invalid user data location.'); }
const manager = new CoreManager(storeRoot);

function fail(code: string, message: string): never {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: code.slice(0, 200), message: message.slice(0, 2000) } })}\n`);
  process.exit(1);
}
function trust(): { publicKeys: Record<string, string>; environment: 'test' | 'production' } {
  const file = process.env.BH_CORE_TRUST_CONFIG?.trim();
  if (!file) fail('trust_config_missing', 'Manager trust configuration is required for provisioning.');
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as { environment?: string; publicKeys?: Record<string, string> };
  if ((raw.environment !== 'test' && raw.environment !== 'production') || !raw.publicKeys || !Object.keys(raw.publicKeys).length) fail('trust_config_invalid', 'Manager trust configuration is invalid.');
  return { environment: raw.environment, publicKeys: raw.publicKeys };
}

/** A short-lived Manager invocation can find the store lock held by another
 *  host at the instant a Core asks for its idle stop. `lock_busy` means this
 *  call never entered the lock, so retrying cannot replay a mutation. */
async function retryBusy<T>(action: () => Promise<T>, budgetMs = 2_500): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try { return await action(); }
    catch (error) {
      if (!(error instanceof StoreLockError) || error.code !== 'lock_busy' || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) fail('request_too_large', 'Manager request exceeds the limit.');
}
let request: Record<string, unknown>;
try { request = JSON.parse(input); } catch { fail('request_invalid', 'Manager request must be JSON.'); }
if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.command !== 'string') fail('request_invalid', 'Manager command is required.');

try {
  let result: unknown;
  switch (request.command) {
    // Startup must read the canonical endpoint before joining another host's
    // in-flight start. Wait for the lock; never bypass it or retry a mutation.
    case 'resolve-endpoint': result = await retryBusy(() => new CoreLifecycle(manager, trust()).resolveEndpoint(request.request), STARTUP_READ_WAIT_MS); break;
    case 'configure-endpoint': result = await new CoreLifecycle(manager, trust()).configureEndpoint(request.request); break;
    case 'inspect-maintenances': result = await new CoreLifecycle(manager, trust()).inspectMaintenances(); break;
    case 'upgrade-core': result = await new CoreLifecycle(manager, trust()).upgradeCore(request.request); break;
    case 'inspect-upgrades': result = await new CoreLifecycle(manager, trust()).inspectUpgrades(); break;
    case 'maintain-core': result = await new CoreLifecycle(manager, trust()).maintainCore(request.request); break;
    case 'recover-maintenance': result = await new CoreLifecycle(manager, trust()).recoverMaintenance(request.request); break;
    case 'inspect-maintenance': result = await new CoreLifecycle(manager, trust()).inspectMaintenance(request.requestId); break;
    case 'open-browser': result = await openManagedBrowser(new CoreLifecycle(manager, trust()), request.request); break;
    case 'start-bundled-core': result = await new CoreLifecycle(manager, trust()).startBundledCore(request.request); break;
    case 'ensure-core': result = await new CoreLifecycle(manager, trust()).ensureCore(request.request); break;
    case 'activate-cold-core': result = await new CoreLifecycle(manager, trust()).activateColdCore(request.request); break;
    case 'inspect-start': result = await retryBusy(() => new CoreLifecycle(manager, trust()).inspectStart(), STARTUP_READ_WAIT_MS); break;
    case 'recover-start': result = await new CoreLifecycle(manager, trust()).recoverStart(request.request); break;
    case 'reconnect-core': result = await new CoreLifecycle(manager, trust()).reconnectCore(request.request); break;
    case 'attach-or-start': result = await new CoreLifecycle(manager, trust()).attachOrStart(request.request); break;
    // The native keeper renews every 15s against a zero-wait lock that this
    // same store hands out to idle ticks and other clients; a single busy
    // store must not be reported as a lost lease.
    case 'heartbeat': result = await retryBusy(() => new CoreLifecycle(manager, trust()).heartbeat(request.request)); break;
    case 'detach': result = await new CoreLifecycle(manager, { environment: 'production', publicKeys: {} }).detach(request.handle); break;
    // Core proposes its own exact incarnation; only Manager may decide that
    // every host lease is gone and issue the signed idle-stop transaction.
    case 'stop-idle-core': result = await retryBusy(() => new CoreLifecycle(manager, trust()).stopIdleCore(request.request)); break;
    case 'select': result = manager.select(typeof request.pointer === 'string' ? request.pointer : 'active.json') ?? null; break;
    case 'register-client': result = await manager.registerClient(request.client as never); break;
    case 'write-lease': manager.writeLease(request.lease as never); result = { written: true }; break;
    case 'activate': if (typeof request.versionName !== 'string') fail('request_invalid', 'versionName is required.'); await manager.activate(request.versionName); result = { activated: request.versionName }; break;
    case 'recover': result = await manager.recoverTransactions(); break;
    case 'query-transaction': if (typeof request.transactionId !== 'string') fail('request_invalid', 'transactionId is required.'); result = manager.queryTransaction(request.transactionId) ?? null; break;
    case 'gc': result = { removed: await manager.garbageCollect(Array.isArray(request.protect) ? request.protect.filter((x): x is string => typeof x === 'string') : []) }; break;
    case 'provision': {
      if (typeof request.archive !== 'string' || (request.source !== 'seed' && request.source !== 'download')) fail('request_invalid', 'archive and source are required.');
      const config = trust();
      result = await manager.provision(path.resolve(request.archive), request.source, (archive, destination) => extractVerifiedCoreArchive(archive, destination, { publicKeys: config.publicKeys, platform: process.platform, arch: process.arch, environment: config.environment }), request.source === 'seed' ? 15_000 : 0);
      break;
    }
    default: fail('command_unknown', `Unsupported Manager command: ${request.command}`);
  }
  const output = JSON.stringify({ ok: true, result });
  if (Buffer.byteLength(output) > 1024 * 1024) fail('response_too_large', 'Manager response exceeds the limit; query state before retrying a mutation.');
  process.stdout.write(`${output}\n`);
} catch (error) {
  const candidate = error instanceof StoreLockError ? error.code : error instanceof Error && error.name === 'ZodError' ? 'request_invalid' : error instanceof Error ? error.message.split(':', 1)[0] : 'manager_failed';
  const code = candidate && /^[a-z][a-z0-9_]{0,199}$/.test(candidate) ? candidate : 'manager_failed';
  fail(code, error instanceof Error ? error.message : String(error));
}
