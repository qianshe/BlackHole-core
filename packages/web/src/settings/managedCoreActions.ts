import { request } from '../api';
import { settingsHost, type NativeCoreAction } from './host';

const coreActions: ReadonlyArray<NativeCoreAction> = ['apply-settings', 'configure-port', 'inspect-maintenance', 'stop', 'restart'];

function checkedResult(result: unknown): { completed: boolean } {
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(key => key !== 'completed') || typeof (result as { completed?: unknown }).completed !== 'boolean') throw new Error('maintenance_result_unknown');
  return result as { completed: boolean };
}

/** Only a native host bridge can dispatch these actions: the VS Code message
 * bridge or the Desktop WebView bridge. Browser fetch is never a substitute
 * for a native confirmation or a Manager authorization, and a cancelled or
 * refused native operation reports completed=false instead of success. */
export async function runManagedCoreAction(action: NativeCoreAction, revision?: number): Promise<{ completed: boolean }> {
  if (!coreActions.includes(action)) throw new Error('invalid_core_action');
  if (action === 'apply-settings' && (!Number.isSafeInteger(revision) || revision! < 0)) throw new Error('invalid_settings_revision');
  if (action !== 'apply-settings' && revision !== undefined) throw new Error('invalid_core_action');
  const host = settingsHost();
  if (host.coreAction) return checkedResult(await host.coreAction(action, revision));
  if (host.kind !== 'vscode' || action === 'stop' || action === 'restart') throw new Error('native_maintenance_required');
  const result = await request<unknown>(`/host/core/${action}`, { method: 'POST', body: JSON.stringify(action === 'apply-settings' ? { revision } : {}) });
  return checkedResult(result);
}
