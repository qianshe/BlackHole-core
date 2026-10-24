export type DesktopDownloadStatus = {
  state: 'downloading' | 'verifying' | 'cancelling' | 'ready' | 'cancelled' | 'error' | 'interrupted';
  version: string; bytes: number; totalBytes: number;
};
export type DesktopUpdateStatus = {
  state: 'idle' | 'checking' | 'current' | 'available' | 'error' | 'unconfigured' | 'unsupported' | 'update_unavailable';
  currentVersion: string;
  availableVersion?: string;
  checkedAt?: string;
  download?: DesktopDownloadStatus;
};
// 'download' is the page-authorized download-and-install flow; the click in the Desktop's own native-hosted settings UI is the authorization.
type UpdateAction = 'status' | 'check' | 'download' | 'cancel-download';
type UpdateBridge = (action: UpdateAction) => Promise<string>;
function parseDownload(raw: unknown): DesktopDownloadStatus | undefined {
  if (!raw || typeof raw !== 'object') return;
  const d = raw as Record<string, unknown>;
  if (!['downloading','verifying','cancelling','ready','cancelled','error','interrupted'].includes(String(d.state)) || typeof d.version !== 'string' || !version.test(d.version)) return;
  if (typeof d.bytes !== 'number' || typeof d.totalBytes !== 'number' || !Number.isSafeInteger(d.bytes) || !Number.isSafeInteger(d.totalBytes) || d.bytes < 0 || d.totalBytes < 1024 * 1024 || d.totalBytes > 1024 ** 3 || d.bytes > d.totalBytes) return;
  return { state: d.state as DesktopDownloadStatus['state'], version: d.version, bytes: d.bytes, totalBytes: d.totalBytes };
}
const version = /^\d{1,10}\.\d{1,10}\.\d{1,10}$/;
const states = new Set(['idle', 'checking', 'current', 'available', 'error', 'unconfigured', 'unsupported', 'update_unavailable']);
export function parseDesktopUpdate(raw: unknown): DesktopUpdateStatus | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || !states.has(String(value.state)) || typeof value.currentVersion !== 'string' || !version.test(value.currentVersion)) return null;
  if (value.state === 'available' && (typeof value.availableVersion !== 'string' || !version.test(value.availableVersion))) return null;
  const checked = typeof value.checkedAt === 'string' && Number.isFinite(Date.parse(value.checkedAt)) && Date.parse(value.checkedAt) > 0 ? value.checkedAt : undefined;
  const download = parseDownload(value.download);
  return { state: value.state as DesktopUpdateStatus['state'], currentVersion: value.currentVersion,
    ...(value.state === 'available' ? { availableVersion: value.availableVersion as string } : {}), ...(checked ? { checkedAt: checked } : {}), ...(download ? { download } : {}) };
}
export async function readDesktopUpdate(action: UpdateAction): Promise<DesktopUpdateStatus | null> {
  const bridge = (globalThis as typeof globalThis & { blackholeDesktopUpdateAction?: UpdateBridge }).blackholeDesktopUpdateAction;
  if (typeof bridge !== 'function') return null;
  try { return parseDesktopUpdate(await bridge(action)); } catch { return null; }
}
