import fs from 'node:fs';
import path from 'node:path';
import { connect } from 'node:net';
import type { ControlApi, Health } from './controlApi';

type LegacyApi = Pick<ControlApi, 'health' | 'listSessions' | 'shutdown'>;
type LegacyIdentity = { daemonId: string; fingerprint: string; version: string };
const LEGACY_VERSION_PATTERN = /^0[.]3[.]\d+$/;

/** Never stop an unexpected listener or a Core using another user's data. */
async function inspectLegacy(api: LegacyApi, port: number, db: string): Promise<LegacyIdentity> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('legacy_port_invalid');
  const health: Health = await api.health(3_000, port);
  if (health.lifecycle_state === 'managed') throw Error('managed_core_requires_manager');
  if (typeof health.version !== 'string' || !LEGACY_VERSION_PATTERN.test(health.version) || health.ok !== true) throw Error('legacy_core_version_unknown');
  if (!health.daemon_id || typeof health.start_fingerprint !== 'string' || !health.start_fingerprint.length) throw Error('legacy_core_identity_unknown');
  let currentDb: string, expectedDb: string;
  try {
    currentDb = fs.realpathSync.native(String(health.db_path));
    expectedDb = fs.realpathSync.native(db);
  } catch { throw Error('legacy_data_root_unknown'); }
  const normalized = (v: string) => process.platform === 'win32' ? path.normalize(v).toLowerCase() : path.normalize(v);
  if (normalized(currentDb) !== normalized(expectedDb)) throw Error('legacy_data_root_conflict');
  // The old daemon lacks Manager's signed active-work seal. Be more
  // conservative: require its native activity counters AND its session list.
  if (!Number.isInteger(health.sessions_running) || !Number.isInteger(health.approvals_pending)) throw Error('legacy_activity_unknown');
  if (health.sessions_running! > 0 || health.approvals_pending! > 0) throw Error('active_work');
  // The native configuration can change while a modal is open; inspect the
  // same observed loopback port instead of the latest mutable UI setting.
  const snapshot = await api.listSessions(port);
  if (!Array.isArray(snapshot.sessions)) throw Error('legacy_activity_unknown');
  if (snapshot.sessions.some(s => s.activity === 'running')) throw Error('active_work');
  return { daemonId: health.daemon_id, fingerprint: health.start_fingerprint, version: health.version };
}

async function portRefused(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (result?: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result === true);
    };
    socket.setTimeout(750, () => done(undefined, Error('legacy_port_probe_unknown')));
    socket.once('connect', () => done(false));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') done(true);
      else done(undefined, Error('legacy_port_probe_unknown'));
    });
  });
}

/** One native, user-confirmed migration action. Never use this from Web.
 * It does not start Core: the caller retries Manager only after a proved close. */
export async function stopLegacyForHandoff(
  api: LegacyApi,
  port: number,
  db: string,
  confirm: () => Promise<boolean>,
  checkClosed: (port: number) => Promise<boolean> = portRefused,
): Promise<boolean> {
  const observed = await inspectLegacy(api, port, db);
  if (!(await confirm())) return false;
  const current = await inspectLegacy(api, port, db);
  if (current.daemonId !== observed.daemonId || current.fingerprint !== observed.fingerprint || current.version !== observed.version)
    throw Error('legacy_core_identity_changed');
  const result = await api.shutdown(observed.daemonId, observed.fingerprint, port);
  if (result?.ok !== true) throw Error('legacy_stop_unconfirmed');
  // The old HTTP listener is not sufficient proof of process death, so wait
  // for a second independent probe after its ordinary cleanup interval.
  const deadline = Date.now() + 15_000;
  let firstClosed = false;
  while (Date.now() < deadline) {
    if (await checkClosed(port)) {
      if (firstClosed) return true;
      firstClosed = true;
      await new Promise(resolve => setTimeout(resolve, 500));
    } else {
      firstClosed = false;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw Error('legacy_stop_unconfirmed');
}
