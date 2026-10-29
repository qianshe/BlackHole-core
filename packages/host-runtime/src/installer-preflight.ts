// Read-only installer preparation. Does NOT acquire CoreManager locks (which
// initialize directories), open SQLite, recover journals or stop Core.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { z } from 'zod';
import { resolveDataPaths } from '../../../src/data-paths.ts';
import { ClientLeaseSchema, ProvisionTransactionSchema } from '../../contracts/src/core-runtime.ts';
import { CoreEndpointSchema, CoreMaintenanceRecordSchema, CoreUpgradeRecordSchema, RunningCoreRecordSchema } from '../../contracts/src/manager-protocol.ts';

export type PreflightCode = 'ready' | 'core_running' | 'legacy_core_running' | 'active_clients' | 'recovery_required' | 'state_unreadable' | 'listener_unknown';
export type PreflightResult = { schemaVersion: 1; ok: boolean; code: PreflightCode; port: number; readOnly: true };
type HealthReader = (port: number) => Promise<{ status: number; body: string } | null>;
export const PREFLIGHT_EXIT: Record<PreflightCode, number> = { ready: 0, core_running: 40, legacy_core_running: 41, active_clients: 42, recovery_required: 43, state_unreadable: 44, listener_unknown: 45 };

export const readInstallerHealth: HealthReader = port => new Promise((resolve, reject) => {
  const req = http.get({ hostname: '127.0.0.1', port, path: '/api/health', agent: false }, response => {
    const chunks: Buffer[] = []; let bytes = 0;
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) { req.destroy(new Error('response_too_large')); return; }
      chunks.push(chunk);
    });
    response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    response.once('error', reject);
  });
  const timeout = setTimeout(() => req.destroy(new Error('health_timeout')), 3000);
  req.once('close', () => clearTimeout(timeout));
  req.once('error', error => (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? resolve(null) : reject(error));
});

function safePath(root: string, relative: string): string | null {
  let file = root;
  for (const part of ['', ...relative.split('/').filter(Boolean)]) {
    if (part) file = path.join(file, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    if (stat.isSymbolicLink()) throw new Error('state_link');
  }
  return file;
}
function readJson(root: string, relative: string): unknown {
  const file = safePath(root, relative);
  if (!file) return undefined;
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('state_invalid');
  const data = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(data) > 1024 * 1024) throw new Error('state_invalid');
  return JSON.parse(data);
}
function records(root: string, directory: string): unknown[] {
  const dir = safePath(root, directory);
  if (!dir) return [];
  const entries = fs.readdirSync(dir);
  if (entries.length > 4096) throw new Error('state_limit');
  return entries.filter(name => name.endsWith('.json')).map(name => readJson(root, directory + '/' + name));
}
export async function inspectInstallerReadiness(options: {
  env?: NodeJS.ProcessEnv; port?: number; now?: number; readHealth?: HealthReader;
} = {}): Promise<PreflightResult> {
  let port = options.port ?? 7306;
  const out = (code: PreflightCode): PreflightResult => ({ schemaVersion: 1, ok: code === 'ready', code, port, readOnly: true });
  try {
    z.number().int().min(1).max(65535).parse(port);
    const data = resolveDataPaths({ env: options.env });
    const root = data.root;
    const endpoint = readJson(root, 'core/state/endpoints/' + data.dataRootId + '.json');
    if (endpoint !== undefined) {
      const saved = CoreEndpointSchema.parse(endpoint);
      if (saved.dataRootId !== data.dataRootId) return out('state_unreadable');
      port = saved.port;
    }
    // HTTP data never enters logs or UI. Refuse both legacy and new owners;
    // this conservative preflight requires explicit, protected shutdown first.
    // It is a precheck, NOT a grant to race concurrent launches during copying.
    for (const candidate of new Set([7306, port])) {
      let response;
      try { response = await (options.readHealth ?? readInstallerHealth)(candidate); } catch { return out('listener_unknown'); }
      if (!response) continue;
      let health: Record<string, unknown>;
      try { health = JSON.parse(response.body); } catch { return out('listener_unknown'); }
      if (response.status !== 200 || !health || typeof health.db_path !== 'string' || typeof health.daemon_id !== 'string' || !health.daemon_id || !path.isAbsolute(health.db_path)) return out('listener_unknown');
      const canonical = (v: string) => (process.platform === 'win32' || process.platform === 'darwin') ? path.resolve(v).toLowerCase() : path.resolve(v);
      if (candidate !== port && canonical(health.db_path) !== canonical(data.db)) continue;
      return out(health.lifecycle_state === 'managed' ? 'core_running' : 'legacy_core_running');
    }
    for (const raw of records(root, 'core/state/running')) { RunningCoreRecordSchema.parse(raw); return out('recovery_required'); }
    for (const raw of records(root, 'core/state/client-leases')) {
      const lease = ClientLeaseSchema.parse(raw);
      if (lease.dataRootId === data.dataRootId && Date.parse(lease.expiresAt) > (options.now ?? Date.now())) return out('active_clients');
    }
    for (const raw of records(root, 'core/state/maintenance')) {
      const record = CoreMaintenanceRecordSchema.parse(raw);
      if (!['completed','refused','recovered_stopped','recovered_running'].includes(record.state)) return out('recovery_required');
    }
    for (const raw of records(root, 'core/state/upgrade')) {
      const record = CoreUpgradeRecordSchema.parse(raw);
      if (!['committed','rolled_back','refused'].includes(record.state)) return out('recovery_required');
    }
    for (const raw of records(root, 'core/state/transactions')) {
      const record = ProvisionTransactionSchema.parse(raw);
      if (!['committed','rolled_back','failed'].includes(record.state)) return out('recovery_required');
    }
    for (const relative of ['core/state/locks/install.lock','core/state/locks/lifecycle.lock']) {
      if (safePath(root, relative)) return out('recovery_required');
    }
    return out('ready');
  } catch { return out('state_unreadable'); }
}
