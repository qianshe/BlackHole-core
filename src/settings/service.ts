import type { DaemonDeps } from '../deps.js';
import { normalizeCourierSite, normalizeSetting, normalizeSettingsPatch, pendingRestartKeys, unseededKeys, MAX_COURIER_SITES, SETTING_KEYS, type Settings, type SettingsRecord } from './store.js';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { directAccessConfig } from '../direct-access/listener.js';

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
  // Capture the saved values now; apply exposes an honest applying/listening/error
  // state on health, while the PATCH response acknowledges persistence only.
  if (r.changed.some((k) => ['directAccessEnabled', 'directPort', 'directAccessUrl', 'publicBaseUrl', 'channelMode', 'aiDefaultRoute'].includes(k))) {
    void deps.directAccess?.apply(directAccessConfig(r.record.values));
  }
  if (r.changed.includes('courierSites')) deps.courier?.pushSites();
  return { status: 200, body: settingsView(deps, r.record) };
}

/** Courier added or updated a site (sites.put). One entry per origin; the id never changes. */
export function putCourierSite(deps: DaemonDeps, raw: unknown): { ok: true } | { ok: false; message: string } {
  if (!deps.settings) return { ok: false, message: 'settings_unavailable' };
  const n = normalizeCourierSite(raw);
  if ('error' in n) return { ok: false, message: n.error };
  const list = deps.settings.get().values.courierSites;
  const same = list.find((x) => x.origin === n.value.origin);
  const site = same ? { ...n.value, id: same.id } : n.value;
  const next = list.some((x) => x.id === site.id) ? list.map((x) => (x.id === site.id ? site : x)) : [...list, site];
  if (next.length > MAX_COURIER_SITES) return { ok: false, message: `at most ${MAX_COURIER_SITES} courierSites` };
  const r = patchSettings(deps, { values: { courierSites: next } }, 'courier', false);
  return r.status === 200 ? { ok: true } : { ok: false, message: String(r.body.message ?? r.body.error) };
}

/** Courier deleted a site (sites.remove). */
export function removeCourierSite(deps: DaemonDeps, id: unknown): { ok: true } | { ok: false; message: string } {
  if (!deps.settings) return { ok: false, message: 'settings_unavailable' };
  const list = deps.settings.get().values.courierSites;
  if (typeof id !== 'string' || !list.some((x) => x.id === id)) return { ok: true };
  const r = patchSettings(deps, { values: { courierSites: list.filter((x) => x.id !== id) } }, 'courier', false);
  return r.status === 200 ? { ok: true } : { ok: false, message: String(r.body.message ?? r.body.error) };
}

/** Reachability check of a public base URL. A supplied application proxy applies to this request only. */
export async function probePublicUrl(raw: unknown, proxyRaw?: unknown): Promise<{ ok: boolean; detail: string }> {
  const n = normalizeSetting('publicBaseUrl', raw);
  if ('error' in n || !n.value) return { ok: false, detail: '请输入完整公网地址，例如 https://example.com 或 http://203.0.113.10:8080' };
  const p = normalizeSetting('channelProxyUrl', typeof proxyRaw === 'string' ? proxyRaw : '');
  if ('error' in p) return { ok: false, detail: '渠道应用代理配置无效' };
  const proxy = typeof p.value === 'string' ? p.value : '';
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  try {
    const response = dispatcher
      ? await undiciFetch(`${n.value}/probe`, { signal: AbortSignal.timeout(8_000), redirect: 'error', dispatcher })
      : await fetch(`${n.value}/probe`, { signal: AbortSignal.timeout(8_000), redirect: 'error' });
    const body = (await response.json().catch(() => null)) as { ok?: unknown; service?: unknown } | null;
    const ok = response.ok && body?.ok === true && body.service === 'blackhole';
    return { ok, detail: ok ? '' : `探测响应无效（HTTP ${response.status}）` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? '探测超时' : '公网地址不可达' };
  } finally {
    try { await dispatcher?.close(); } catch { /* best effort */ }
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
