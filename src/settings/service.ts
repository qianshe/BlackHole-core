import type { DaemonDeps } from '../deps.js';
import { normalizeSetting, normalizeSettingsPatch, pendingRestartKeys, unseededKeys, SETTING_KEYS, type Settings, type SettingsRecord } from './store.js';

/** Shared by /api/settings (extension) and /web-api/v1/settings (Local Web). */
export function settingsView(deps: DaemonDeps, record: SettingsRecord = deps.settings!.get()) {
  return {
    revision: record.revision,
    migrated: record.migrated,
    values: record.values,
    updated_at: record.updated_at,
    // keys the extension may still hand over once (added after this install first migrated)
    unseeded: unseededKeys(record),
    // restart-only keys that differ from what this daemon is running with
    pending_restart: deps.startedSettings && record.migrated ? pendingRestartKeys(deps.startedSettings, record.values) : [],
  };
}

export type SettingsResult = { status: 200; body: ReturnType<typeof settingsView> } | { status: 400 | 409 | 503; body: { error: string; message?: string; current?: ReturnType<typeof settingsView> } };

export function patchSettings(deps: DaemonDeps, body: unknown, source: string, requireRevision: boolean): SettingsResult {
  if (!deps.settings) return { status: 503, body: { error: 'settings_unavailable' } };
  const b = (body ?? {}) as { values?: unknown; revision?: unknown };
  if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(b).some((k) => k !== 'values' && k !== 'revision')) {
    return { status: 400, body: { error: 'invalid_body' } };
  }
  if (b.revision !== undefined && !Number.isInteger(b.revision)) return { status: 400, body: { error: 'invalid_input', message: 'revision must be an integer' } };
  if (requireRevision && b.revision === undefined) return { status: 400, body: { error: 'invalid_input', message: 'revision is required' } };
  const patch = normalizeSettingsPatch(b.values);
  if ('error' in patch) return { status: 400, body: { error: 'invalid_input', message: patch.error } };
  const r = deps.settings.update(patch.values, b.revision as number | undefined);
  if ('conflict' in r) return { status: 409, body: { error: 'revision_conflict', current: settingsView(deps, r.conflict) } };
  if (r.changed.length > 0) deps.events.append(null, 'settings_changed', { source, keys: r.changed, revision: r.record.revision });
  // Turning phone access off ends every pairing now, not on the next request.
  if (r.changed.includes('remoteAccess') && !r.record.values.remoteAccess) deps.revokeRemoteDevices?.();
  return { status: 200, body: settingsView(deps, r.record) };
}

/** Reachability check of a public base URL, same contract as the extension's settings panel. */
export async function probePublicUrl(raw: unknown): Promise<{ ok: boolean; detail: string }> {
  const n = normalizeSetting('publicBaseUrl', raw);
  if ('error' in n || !n.value) return { ok: false, detail: '请输入完整公网地址，例如 https://example.com 或 http://203.0.113.10:8080' };
  try {
    const response = await fetch(`${n.value}/probe`, { signal: AbortSignal.timeout(8_000), redirect: 'error' });
    const body = (await response.json().catch(() => null)) as { ok?: unknown; service?: unknown } | null;
    const ok = response.ok && body?.ok === true && body.service === 'blackhole';
    return { ok, detail: ok ? '' : `探测响应无效（HTTP ${response.status}）` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? '探测超时' : '公网地址不可达' };
  }
}

/**
 * First copy from the extension's VS Code settings; never overwrites daemon-owned values.
 * Once migrated, only keys that were never seeded (added in a later version) are accepted.
 */
export function migrateSettings(deps: DaemonDeps, body: unknown): SettingsResult {
  if (!deps.settings) return { status: 503, body: { error: 'settings_unavailable' } };
  const current = deps.settings.get();
  const open = current.migrated ? unseededKeys(current) : [...SETTING_KEYS];
  if (open.length === 0) return { status: 200, body: settingsView(deps, current) };
  const raw = (body as { values?: unknown } | null)?.values;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 400, body: { error: 'invalid_input', message: 'values must be an object' } };
  // Per key: an old value that fails today's checks is skipped (default kept), never blocks the rest.
  const values: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const k of open) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined) continue;
    const n = normalizeSetting(k, v);
    if ('value' in n) values[k] = n.value;
    else skipped.push(k);
  }
  const r = deps.settings.update(values as Partial<Settings>, current.revision);
  if ('conflict' in r) return { status: 200, body: settingsView(deps, r.conflict) };
  deps.events.append(null, 'settings_migrated', { revision: r.record.revision, keys: Object.keys(values), skipped });
  return { status: 200, body: settingsView(deps, r.record) };
}
