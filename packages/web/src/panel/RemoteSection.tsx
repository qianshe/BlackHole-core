// Phone access controls on this computer (plan 6.13 R4; always on): QR code with
// countdown, paired devices with revoke. The QR code is drawn locally as SVG.
import { useCallback, useEffect, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { ApiError, remoteAdmin, type RemoteView } from '../api';

type Toast = (text: string, tone?: 'info' | 'warn' | 'bad') => void;
type Confirm = (title: string, actions: string[]) => Promise<string | null>;

const REASON: Record<string, string> = {
  off: '手机访问暂不可用。',
  channel_offline: '先启动公网渠道，再生成二维码。',
  not_https: '公网地址需为 https。',
  custom_not_https: '自定义公网地址需为 https。',
};

export function QrCode({ text, size = 220 }: { text: string; size?: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  return (
    <svg className="bhp-qr" width={size} height={size} viewBox={`0 0 ${n + 8} ${n + 8}`} role="img" aria-label="手机访问二维码" shapeRendering="crispEdges">
      <rect width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

const when = (iso: string) => {
  const t = new Date(iso);
  return `${t.getMonth() + 1}月${t.getDate()}日 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};

/**
 * Same split as the VS Code settings page: `pair` is the scan row inside the channel card,
 * `devices` the paired-phone list under 高级 (only `pair` announces new devices).
 */
export function RemoteSection({ toast, confirm, part }: { toast: Toast; confirm: Confirm; part: 'pair' | 'devices' }) {
  const [view, setView] = useState<RemoteView | null>(null);
  const [pair, setPair] = useState<{ url: string; expiresAt: number; kind: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const known = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await remoteAdmin.view();
      setView(v);
      const ids = new Set(v.devices.map((d) => d.id));
      if (known.current) {
        const added = v.devices.filter((d) => !known.current!.has(d.id));
        if (added.length && part === 'pair') {
          toast('新设备已配对：' + added.map((d) => d.name).join('、'));
          setPair(null);
        }
      }
      known.current = ids;
      // scanned: the 允许 / 拒绝 prompt takes over from the QR code
      if (v.requests?.length) setPair(null);
    } catch { /* daemon restarting: keep the last view */ }
  }, [toast, part]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), pair ? 2000 : 5000); return () => clearInterval(t); }, [load, pair]);
  useEffect(() => { if (!pair) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [pair]);

  const showQr = async () => {
    try {
      const r = await remoteAdmin.pair();
      setPair({ url: r.url, expiresAt: Date.parse(r.expires_at), kind: r.kind });
      setNow(Date.now());
    } catch (e) {
      toast(e instanceof ApiError && e.code === 'remote_unavailable' ? '暂时无法生成二维码：' + (REASON[view?.reason ?? ''] ?? '请检查公网渠道。') : '生成二维码失败，请重试。', 'warn');
      void load();
    }
  };
  const revoke = async (id: string, name: string) => {
    if ((await confirm(`撤销「${name}」？该手机需要重新扫码才能访问。`, ['撤销'])) !== '撤销') return;
    try { setView(await remoteAdmin.revoke(id)); toast(`已撤销「${name}」。`); } catch { toast('撤销失败，请重试。', 'bad'); }
  };

  const left = pair ? Math.max(0, Math.ceil((pair.expiresAt - now) / 1000)) : 0;
  const status = view?.available ? { cls: 'ok', text: '可扫码' + (view.kind === 'quick' ? ' · 临时渠道' : '') } : { cls: 'warn', text: '暂不可用' };
  if (part === 'devices') {
    return (
      <>
        <div className="subsec">已配对的手机</div>
        {!view?.devices.length ? <div className="hint" style={{ margin: 0 }}>还没有配对的手机。</div> : view.devices.map((d) => (
          <div className="ag-row" key={d.id}>
            <span className="nm">{d.name}</span>
            <span className="u">配对 {when(d.created_at)} · 最近访问 {when(d.last_seen_at)}</span>
            <button className="del" type="button" onClick={() => void revoke(d.id, d.name)}>撤销</button>
          </div>
        ))}
      </>
    );
  }
  return (
    <>
      <div className="chrow">
        <span className={'chst ' + status.cls}>手机访问 · {status.text}</span>
        <span className="sp" />
        <button type="button" className="secondary" disabled={!view?.available} onClick={() => void showQr()}>手机扫码</button>
      </div>
      {view && !view.available && <div className="hint">{REASON[view.reason ?? ''] ?? REASON.off}</div>}
      {view?.available && view.kind === 'quick' && <div className="hint">临时渠道：渠道停止或地址变化后需要重新扫码。</div>}
      {pair && (
        <div className="buy-modal" role="dialog" aria-modal="true" aria-labelledby="bhpQrTitle" onClick={(e) => { if (e.target === e.currentTarget) setPair(null); }} onKeyDown={(e) => { if (e.key === 'Escape') setPair(null); }}>
          <div className="buy-dialog">
            <div className="buy-dialog-head"><div className="buy-dialog-eyebrow">BLACKHOLE · 手机访问</div><div className="buy-dialog-title" id="bhpQrTitle">用手机相机扫码</div></div>
            <div className="buy-dialog-body bhp-qr-body">
              {left > 0 ? <QrCode text={pair.url} /> : <div className="bhp-qr-expired">二维码已过期</div>}
              <div className="buy-dialog-note" role="status">{left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 后过期 · 扫码后在电脑上点「允许」` : '请重新生成。'}</div>
            </div>
            <div className="buy-dialog-actions">
              <button className="secondary" type="button" onClick={() => setPair(null)}>关闭</button>
              <button type="button" autoFocus onClick={() => void showQr()}>重新生成</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
