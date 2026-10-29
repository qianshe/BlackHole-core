import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, api, request, type AccountView } from '../api';
import { SettingsModal } from '../console/SettingsModal';
import { installSettingsHost } from './host';
import { SETTINGS_PAGES, type SettingsPage } from '../../../contracts/src/settings-navigation';
import type { SettingsReply } from '../../../contracts/src/settings-host';
import '../global.css';
import './native.css';

declare function acquireVsCodeApi(): { postMessage(value: unknown): void; getState(): Record<string, string> | undefined; setState(value: Record<string, string>): void };
const native = acquireVsCodeApi();
// Document-scoped IDs prevent a Webview reload from reusing old write requests.
const clientId = crypto.randomUUID().replaceAll('-', '');
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
let seq = 0;
function invoke<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (init.signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  const id = `${clientId}_${++seq}`;
  return new Promise<T>((resolve, reject) => {
    const abort = () => finish(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(new ApiError(504, 'settings_timeout', '操作结果暂未确认；请刷新状态后再决定是否重试。')), 180_000);
    const cleanup = () => { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); pending.delete(id); };
    const finish = (error: Error) => { cleanup(); reject(error); };
    pending.set(id, { resolve: value => resolve(value as T), reject, cleanup });
    init.signal?.addEventListener('abort', abort, { once: true });
    try {
      native.postMessage({ type: 'settings:request', clientId, request: { id, method: init.method ?? 'GET', path, ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}) } });
    } catch (error) { finish(error instanceof Error ? error : Error('settings_request_failed')); }
  });
}
installSettingsHost({
  kind: 'vscode', request: invoke,
  copy: async text => (await invoke<{ copied: boolean }>('/host/clipboard', { method: 'POST', body: JSON.stringify({ text }) })).copied,
  readState: key => native.getState()?.[key] ?? null,
  saveState: (key, value) => {
    const state = { ...native.getState(), [key]: value }; native.setState(state);
    native.postMessage({ type: 'settings:state', clientId, page: state['blackhole.settingsLastPage.v1'] ?? 'home', collapsed: state['blackhole.settingsNavCollapsed.v1'] === '1' });
  },
});
window.addEventListener('message', event => {
  const m = event.data;
  if (m?.type !== 'settings:reply') return;
  const reply = m.reply as SettingsReply, callback = pending.get(reply?.id);
  if (!callback) return;
  callback.cleanup();
  if (reply.ok) callback.resolve(reply.value);
  else callback.reject(new ApiError(reply.error?.status ?? 500, reply.error?.code ?? 'settings_failed', reply.error?.detail));
});
window.addEventListener('pagehide', () => {
  for (const callback of [...pending.values()]) { callback.cleanup(); callback.reject(new Error('settings_closed')); }
});
document.addEventListener('click', event => {
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
  if (!anchor || !/^https?:\/\//i.test(anchor.href)) return;
  event.preventDefault();
  void invoke('/host/external', { method: 'POST', body: JSON.stringify({ url: anchor.href }) }).catch(console.error);
});

function App({ initialPage }: { initialPage: SettingsPage }) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [account, setAccount] = useState<AccountView | null>(null);
  const refresh = async () => { const value = await api.account(); setAccount(value); return value; };
  useEffect(() => {
    let alive = true;
    const read = () => { void api.account().then(value => { if (alive) setAccount(value); }, () => { if (alive) setAccount(null); }); };
    read(); const timer = setInterval(read, 5000);
    const navigate = (event: MessageEvent) => { if (event.data?.type === 'settings:navigate' && SETTINGS_PAGES.includes(event.data.page)) setPage(event.data.page); };
    window.addEventListener('message', navigate);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('message', navigate); };
  }, []);
  return <SettingsModal section={page} account={account} onAccountChange={setAccount} refreshAccount={refresh}
    onSignOut={() => { void request<AccountView>('/host/sign-out', { method: 'POST', body: '{}' }).then(setAccount, () => undefined); }}
    onSection={setPage} onClose={() => { void request('/host/close', { method: 'POST', body: '{}' }); }} />;
}
let mounted = false;
window.addEventListener('message', event => {
  const m = event.data;
  if (m?.type !== 'settings:init' || mounted || (m.clientId !== undefined && m.clientId !== clientId)) return;
  mounted = true;
  const page = SETTINGS_PAGES.includes(m.page) ? m.page as SettingsPage : 'home';
  native.setState({ ...native.getState(), 'blackhole.settingsLastPage.v1': page, 'blackhole.settingsNavCollapsed.v1': m.collapsed ? '1' : '0' });
  createRoot(document.getElementById('root')!).render(<App initialPage={page} />);
});
native.postMessage({ type: 'settings:ready', clientId });
