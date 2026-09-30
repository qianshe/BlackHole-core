import type { ControlApi, CourierSendResult, CourierStopResult, SessionInfo } from './controlApi';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Chat composer send (sidebar detail page). With a bound web chat the text goes there as is;
 * without one, Courier opens a new chat, binds it to this session and the first message carries
 * the connector prompt so the web agent can call BlackHole right away.
 */
export async function chatSend(api: ControlApi, s: SessionInfo, targetId: string | null, text: string, site: string = 'arena'): Promise<CourierSendResult> {
  try {
    if (targetId) return await api.courierSend({ targetId, sessionId: s.id, text });
    // The daemon wraps the typed text in the connector prompt (its Task); the thread and the
    // session name show only the typed text.
    // The daemon picks the template by site (connector: ChatGPT/Claude/Manus, sandbox otherwise); this one is ignored.
    return await api.courierStart({ sessionId: s.id, text, site, template: site === 'arena' ? 'sandbox' : 'connector' });
  } catch (e) {
    return { ok: false, code: 'error', message: msg(e), sent: false };
  }
}

/**
 * Sidebar stop button: asks the bound web chat to press its own stop control, so the web AI
 * actually stops instead of the plugin merely looking away. `not_running` means the page had
 * no visible stop control - the turn was already over.
 */
export async function chatStop(api: ControlApi, s: SessionInfo, targetId: string | null): Promise<CourierStopResult> {
  if (!targetId) return { ok: false, code: 'no_target', message: '这个会话没有配对的网页会话，无法停止' };
  try {
    const r = await api.courierStop({ targetId, sessionId: s.id });
    if (r.ok) return { ok: true, message: r.message };
    if (r.code === 'not_running') return { ok: false, code: 'not_running', message: '页面当前没有在生成，无需停止' };
    return { ok: false, ...(r.code ? { code: r.code } : {}), message: r.message || '停止失败' };
  } catch (e) {
    return { ok: false, code: 'error', message: msg(e) };
  }
}
