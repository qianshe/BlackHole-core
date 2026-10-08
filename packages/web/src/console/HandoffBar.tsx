// Handoff in the Web console: the session's AI saved transfer context (workflow=handoff). The bar
// under the session header lets the user read it and copy a full prompt for the next web AI; the
// context is cleared by the daemon as soon as the next AI starts working in this session.
// The prompt is assembled from one fresh snapshot (same checks as VS Code, handoffCopy.ts).
import { useState } from 'react';
import { api, type SessionView } from '../api';
import { prepareHandoffPrompt } from '../../../vscode/src/handoffCopy';
import { relativeTime } from '../format';
import { Icon } from '../ui';
import { copyText, DialogHead, failText, Modal, useToast } from './common';
import c from './console.module.css';
import h from './Handoff.module.css';

type Kind = 'connector' | 'sandbox';
const HINT = '复制的提示词包含这个会话的访问凭据，只发给要接手的网页 AI。新 AI 开始干活后，这份 Handoff 会自动清除。';
const shim = { handoff: (id: string) => api.handoff(id) } as unknown as Parameters<typeof prepareHandoffPrompt>[0];

export function HandoffBar({ session, connectorName, now }: { session: SessionView; connectorName: string; now: number }) {
  const toast = useToast();
  const [busy, setBusy] = useState<Kind | null>(null);
  const [view, setView] = useState<{ text: string | null; error: string | null } | null>(null);
  const pending = session.pending_handoff;
  if (!pending) return null;
  const active = session.status === 'active';
  const why = active ? HINT : '会话已暂停或不可用，恢复后再复制';

  const copy = async (kind: Kind): Promise<void> => {
    if (busy || !active) return;
    setBusy(kind);
    try {
      const text = await prepareHandoffPrompt(shim, session.id, pending.id, kind, connectorName);
      const ok = await copyText(text);
      toast(ok ? `Handoff 提示词已复制（${kind === 'connector' ? '连接器' : '沙箱直连'}），发给新的网页 AI 即可接着做` : '复制失败', ok ? 'ok' : 'bad');
    } catch (e) {
      toast(e instanceof Error && !('code' in e) ? e.message : failText(e), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const open = async (): Promise<void> => {
    setView({ text: null, error: null });
    try {
      const snap = await api.handoff(session.id);
      if (!snap.handoff || snap.handoff.id !== pending.id) setView({ text: null, error: 'Handoff 已更新或已清除，请刷新会话' });
      else setView({ text: snap.handoff.content, error: null });
    } catch (e) {
      setView({ text: null, error: failText(e) });
    }
  };
  const buttons = (
    <>
      <button type="button" className={c.btn} disabled={!!busy || !active} title={why} onClick={() => void copy('connector')}>
        {busy === 'connector' ? '复制中…' : '复制 · 连接器'}
      </button>
      <button type="button" className={c.btn} disabled={!!busy || !active} title={why} onClick={() => void copy('sandbox')}>
        {busy === 'sandbox' ? '复制中…' : '复制 · 沙箱直连'}
      </button>
    </>
  );

  return (
    <div className={h.bar} role="region" aria-label="Handoff">
      <Icon name="link" size={14} className={h.icon} />
      <div className={h.text}>
        <b>待接手的 Handoff</b>
        <span className={h.meta}>{relativeTime(pending.created_at, now)}生成 · 交给新的网页 AI 接着做</span>
      </div>
      <div className={h.actions}>
        <button type="button" className={h.link} onClick={() => void open()} aria-haspopup="dialog">查看</button>
        {buttons}
      </div>
      {view && (
        <Modal label="Handoff" onClose={() => setView(null)} className={`${c.dialog} ${h.dialog}`}>
          <DialogHead title="Handoff · 接力上下文" onClose={() => setView(null)} />
          <p className={h.meta}>{relativeTime(pending.created_at, now)}生成</p>
          {view.error ? <p className={h.error}>{view.error}</p> : view.text === null ? <p className={h.meta}>正在读取…</p> : <pre className={h.body} tabIndex={0}>{view.text}</pre>}
          <p className={h.meta}>{why}</p>
          <div className={h.dialogActions}>{buttons}</div>
        </Modal>
      )}
    </div>
  );
}
