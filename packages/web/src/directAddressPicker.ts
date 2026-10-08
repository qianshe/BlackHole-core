import type { McpRouteCandidate } from '../../contracts/src/connections';
import type { Health } from './api';
import styles from './console/console.module.css';
const c = styles as Record<'overlay' | 'dialog' | 'dialogHead' | 'dialogTitle' | 'dialogBody' | 'dialogActions' | 'btn', string>;

let pickerOpen = false;

/** One-off choice only: never writes a network setting or starts a channel. */
export function pickDirectAddress(candidates: readonly McpRouteCandidate[]): Promise<string | null> {
  const items = candidates.filter((item) => item.kind === 'direct');
  if (!items.length || pickerOpen) return Promise.resolve(null);
  if (items.length === 1) return Promise.resolve(items[0]!.url);
  pickerOpen = true;
  const previous = document.activeElement as HTMLElement | null;
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = c.overlay;
    dialog.setAttribute('aria-label', '选择直连地址');
    const card = document.createElement('div'); card.className = c.dialog;
    const head = document.createElement('div'); head.className = c.dialogHead;
    const title = document.createElement('h2'); title.className = c.dialogTitle; title.textContent = '选择直连地址';
    head.append(title);
    const body = document.createElement('div'); body.className = c.dialogBody;
    const description = document.createElement('p');
    description.textContent = '选择目标 Agent 能访问的地址。仅用于这次复制，不会修改默认连接或切换渠道。';
    body.append(description);
    const list = document.createElement('div'); list.style.display = 'grid'; list.style.gap = '8px';
    let done = false;
    const finish = (url: string | null) => {
      if (done) return; done = true;
      dialog.close(); dialog.remove(); pickerOpen = false;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      resolve(url);
    };
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = c.btn;
      button.style.textAlign = 'left'; button.style.whiteSpace = 'normal'; button.style.overflowWrap = 'anywhere';
      button.dataset.directCandidate = item.id;
      const parsed = new URL(item.url);
      button.textContent = `${parsed.origin} · ${item.scope === 'public' ? '对外地址' : item.scope === 'loopback' ? '仅本机' : '局域网 / 组网'}`;
      button.addEventListener('click', () => finish(item.url));
      list.append(button);
    }
    body.append(list);
    const actions = document.createElement('div'); actions.className = c.dialogActions;
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = c.btn; cancel.textContent = '取消';
    cancel.addEventListener('click', () => finish(null)); actions.append(cancel);
    card.append(head, body, actions); dialog.append(card); document.body.append(dialog);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) finish(null); });
    dialog.addEventListener('close', () => finish(null));
    try { dialog.showModal(); list.querySelector('button')?.focus(); }
    catch (error) { dialog.remove(); pickerOpen = false; resolve(null); console.error('Direct address picker could not open', error); }
  });
}

/** Revalidate after the user chooses: a changed route/token must not copy a stale URL. */
export async function chooseCurrentDirectAddress(
  health: Health,
  refresh: () => Promise<Health>,
  choose: typeof pickDirectAddress = pickDirectAddress,
): Promise<string | null> {
  const routes = health.connection_routes;
  if (routes?.selected_route !== 'direct' || !routes.needs_choice) return routes?.preferred_mcp_url ?? null;
  const chosen = await choose(routes.mcp_candidates.filter((item) => item.kind === 'direct'));
  if (!chosen) return null;
  const current = (await refresh()).connection_routes;
  if (current?.selected_route !== 'direct' || !current.mcp_candidates.some((item) => item.kind === 'direct' && item.url === chosen)) {
    throw new Error('连接状态已变化，未复制旧地址。请重新选择。');
  }
  return chosen;
}
