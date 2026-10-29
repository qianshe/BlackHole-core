import type { ControlApi } from './controlApi';

/** Native sidebar initialization uses the same daemon-owned settings as the
 * settings page. No legacy restart, local config fallback or public start. */
export async function prepareManagedCloudflared(api: Pick<ControlApi, 'settings' | 'installRuntime' | 'patchSettings'>): Promise<void> {
  const before = await api.settings();
  if (before.managed !== true || typeof before.values.cloudflaredPath !== 'string' || !Number.isInteger(before.revision))
    throw new Error('shared_core_settings_required');
  const originalPath = before.values.cloudflaredPath;
  const result = await api.installRuntime('cloudflared', originalPath);
  const current = await api.settings();
  if (current.managed !== true || !Number.isInteger(current.revision)) throw new Error('shared_core_settings_required');
  if (current.values.cloudflaredPath !== originalPath && current.values.cloudflaredPath !== result.path)
    throw new Error('cloudflared_path_changed_during_install');
  if (current.values.cloudflaredPath === result.path) return;
  const saved = await api.patchSettings({ cloudflaredPath: result.path }, current.revision);
  if (!saved.managed || saved.values.cloudflaredPath !== result.path) throw new Error('cloudflared_path_save_unconfirmed');
}
