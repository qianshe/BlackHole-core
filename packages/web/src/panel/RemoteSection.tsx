// Phone access controls on this computer (plan 6.13 R4; always on): QR code with
// countdown, paired devices with revoke. The QR code is drawn locally as SVG.
import { useCallback, useEffect, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { ApiError, remoteAdmin, type RemoteView } from '../api';
import { phoneEndpointLabel, phoneEndpoints, phoneSelection, phoneStatus } from './phone-state';
import { Modal } from '../console/common';
import { SettingsIcon } from '../ui';

type Toast = (text: string, tone?: 'info' | 'warn' | 'bad') => void;
type Confirm = (title: string, actions: string[]) => Promise<string | null>;

const REASON: Record<string, string> = {
  off: '手机访问暂不可用。',
  channel_offline: '先开启直连或启动可用的公网渠道。',
  not_https: '渠道没有可用的手机入口。',
  direct_applying: '正在应用直连设置，请等待监听状态就绪。',
  direct_unavailable: '直连未就绪，请检查监听端口或本地服务状态。',
  direct_no_address: '没有发现可访问地址，可在「直连」中填写对外访问地址。',
  custom_unavailable: '自定义公网入口未就绪，请检查地址和本地反向代理目标。',
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
export function RemoteSection({ toast, confirm, part, onConfigure }: { toast: Toast; confirm: Confirm; part: 'pair' | 'devices'; onConfigure?: () => void }) {
  const [view, setView] = useState<RemoteView | null>(null);
  const [pair, setPair] = useState<{ url: string; expiresAt: number; kind: string } | null>(null);
  const [origin, setOrigin] = useState('');
  const [probing, setProbing] = useState<Set<string>>(new Set());
  const currentOrigin = useRef(origin); currentOrigin.current = origin;
  const [now, setNow] = useState(Date.now());
  const [qrBusy, setQrBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [deciding, setDeciding] = useState<Set<string>>(new Set());
  const decisionLock = useRef(new Set<string>());
  const decide = async (id: string, allow: boolean) => {
    if (decisionLock.current.has(id)) return;
    decisionLock.current.add(id); setDeciding(new Set(decisionLock.current));
    try { const next = await remoteAdmin.decide(id, allow); if (alive.current) { setView(next); toast(allow ? '已允许此手机配对。' : '已拒绝此配对请求。'); } }
    catch { if (alive.current) { toast('配对请求已过期或处理失败，请刷新状态。', 'warn'); void load(); } }
    finally { decisionLock.current.delete(id); if (alive.current) setDeciding(new Set(decisionLock.current)); }
  };
  const known = useRef<Set<string> | null>(null);
  const alive = useRef(true);
  const loadVersion = useRef(0);
  const qrVersion = useRef(0);
  const qrLock = useRef(false);
  const cancelPair = useCallback(() => { qrVersion.current++; setPair(null); }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; loadVersion.current++; qrVersion.current++; };
  }, []);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const v = await remoteAdmin.view();
      if (!alive.current || version !== loadVersion.current) return;
      setView(v); setLoadError(false);
      const endpoints = phoneEndpoints(v);
      setOrigin((current) => phoneSelection(current, endpoints));
      setPair((old) => old && !endpoints.some((entry) => entry.origin === new URL(old.url).origin) ? null : old);
      const ids = new Set(v.devices.map((d) => d.id));
      if (known.current) {
        const added = v.devices.filter((d) => !known.current!.has(d.id));
        if (added.length && part === 'pair') {
          toast('新设备已配对：' + added.map((d) => d.name).join('、'));
          cancelPair();
        }
      }
      known.current = ids;
      // A scan grants nothing; the computer's pending allow/deny UI takes over.
      if (v.requests?.length) cancelPair();
    } catch { if (alive.current && version === loadVersion.current) { setLoadError(true); cancelPair(); } }
  }, [toast, part, cancelPair]);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await load(); if (!stop) timer = setTimeout(() => void poll(), pair ? 2000 : 5000); };
    void poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [load, !!pair]);
  useEffect(() => { if (!pair) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [pair]);

  const showQr = async () => {
    if (loadError || qrLock.current || !phoneEndpoints(view).some((entry) => entry.origin === origin)) return;
    const version = ++qrVersion.current;
    qrLock.current = true; setQrBusy(true);
    try {
      const r = await remoteAdmin.pair(origin);
      if (!alive.current || version !== qrVersion.current || currentOrigin.current !== origin) return;
      setPair({ url: r.url, expiresAt: Date.parse(r.expires_at), kind: r.kind });
      setNow(Date.now());
    } catch (e) {
      if (!alive.current || version !== qrVersion.current) return;
      toast(e instanceof ApiError && e.code === 'remote_unavailable' ? '暂时无法生成二维码：' + (REASON[view?.reason ?? ''] ?? '请检查连接状态。') : '生成二维码失败，请重试。', 'warn');
      void load();
    } finally { qrLock.current = false; if (alive.current) setQrBusy(false); }
  };
  const revoke = async (id: string, name: string) => {
    if ((await confirm(`撤销「${name}」？该手机需要重新扫码才能访问。`, ['撤销'])) !== '撤销') return;
    try { setView(await remoteAdmin.revoke(id)); toast(`已撤销「${name}」。`); } catch { toast('撤销失败，请重试。', 'bad'); }
  };

  const probeSelected = async () => {
    if (!origin || probing.has(origin)) return;
    const chosen = origin;
    setProbing((old) => new Set(old).add(chosen));
    try { await remoteAdmin.probe(chosen); await load(); }
    catch { toast('检测未完成或入口已变更；未切换到其它入口。', 'warn'); await load(); }
    finally { setProbing((old) => { const next = new Set(old); next.delete(chosen); return next; }); }
  };
  const endpoints = phoneEndpoints(view);
  const selected = endpoints.find((entry) => entry.origin === origin);
  const left = pair ? Math.max(0, Math.ceil((pair.expiresAt - now) / 1000)) : 0;
  const status = phoneStatus(selected);
  const checking = probing.has(origin) || selected?.verification.state === 'checking';
  const pendingRequests = !!view?.requests?.length && <div className="pair-requests" role="region" aria-label="待确认的手机配对">
    <div className="subsec">手机正在等待电脑确认</div>
    {view.requests.map(item => <div className="row-setting" key={item.id}><div><strong>{item.name}</strong><div className="hint">仅允许你正在配对的设备；扫码本身不会获得访问权限。</div></div><div className="btnrow"><button type="button" className="secondary" disabled={deciding.has(item.id)} onClick={() => void decide(item.id, false)}>拒绝</button><button type="button" disabled={deciding.has(item.id)} onClick={() => void decide(item.id, true)}>允许</button></div></div>)}
  </div>;
  if (part === 'devices') {
    return (
      <>
        {pendingRequests}
        <div className="subsec">已配对的手机</div>
        {!view?.devices.length ? <div className="hint" style={{ margin: 0 }}>还没有配对的手机。</div> : view.devices.map((d) => (
          <div className="ag-row" key={d.id}>
            <span className="nm">{d.name}</span>
            <span className="u">配对 {when(d.created_at)} · 最近访问 {when(d.last_seen_at)}</span>
            <button className="del" type="button" aria-label={`撤销 ${d.name} 的手机配对`} onClick={() => void revoke(d.id, d.name)}>撤销</button>
          </div>
        ))}
      </>
    );
  }
  return (
    <>
      {!!view?.requests?.length ? pendingRequests : (
        <>
          <div className="scan-head">
            <div className="scan-icon"><SettingsIcon name="phone-scan" size={20} strokeWidth={1.7} /></div>
            <div className="scan-copy"><h3 className="pair-card-title">手机接入</h3><div className="hint">扫码后需在电脑上确认</div></div>
            <button type="button" id="phonePair" aria-haspopup="dialog" disabled={!view?.available || !selected || qrBusy || loadError} onClick={() => void showQr()}>{qrBusy ? '生成中…' : '生成二维码'}</button>
          </div>
          {(endpoints.length > 1 || (!!origin && !selected)) ? (
            <div className="pair-access-row">
              <span className="pair-access-caption">访问入口</span>
              <select aria-label="手机扫码入口" value={origin} disabled={qrBusy || loadError} onChange={(e) => { setOrigin(e.target.value); cancelPair(); }}>
                {!selected && <option value={origin} disabled>所选入口已不可用，请重新选择</option>}
                {endpoints.map((x) => <option key={x.origin} value={x.origin}>{phoneEndpointLabel(x)}</option>)}
              </select>
            </div>
          ) : selected ? (
            <div className="pair-access-row"><span className="pair-access-text" title={selected.origin}>{phoneEndpointLabel(selected)}</span></div>
          ) : null}
          {!view && !loadError && <div className="pair-access-row" role="status"><span className="pair-access-text">正在读取入口…</span></div>}
          {selected?.verification.state === 'checking' && <div className="pair-access-row" role="status"><span className="pair-access-text">本机检测中…</span></div>}
          {selected?.verification.state === 'failed' && (
            <div className="pair-issue" role="status">
              <span>{status.note}</span>
              <button type="button" className="pair-inline-action" disabled={checking || loadError} onClick={() => void probeSelected()}>重新检测</button>
            </div>
          )}
          {(loadError || (view && (!selected || !view.available))) && (
            <div className="pair-issue" role="status">
              <span>{loadError ? '无法读取入口，请检查本地服务。' : origin && endpoints.length && !selected ? '所选入口已不可用，请重新选择。' : REASON[view?.reason ?? ''] ?? '暂无可用访问入口。'}</span>
              {loadError ? <button type="button" className="pair-inline-action" onClick={() => void load()}>重试</button>
                : !selected && !endpoints.length && onConfigure ? <button type="button" className="pair-inline-action" onClick={() => onConfigure?.()}>配置入口</button> : null}
            </div>
          )}
        </>
      )}
      {pair && (
        <Modal label="手机配对" onClose={cancelPair} className="pair-dialog">
          <div className="pair-dialog-inner">
            <div className="pair-dialog-header">
              <h2 className="pair-dialog-title">手机配对</h2>
              <button type="button" className="pair-close" aria-label="关闭配对弹窗" autoFocus onClick={cancelPair}><SettingsIcon name="close" size={16}/></button>
            </div>
            <div className="pair-dialog-body">
              {left > 0 ? <QrCode text={pair.url} size={176} /> : <div className="bhp-qr-expired">二维码已过期</div>}
              <div className="pair-dialog-status" aria-live="off">{left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 后过期` : '请重新生成'}</div>
              <div className="pair-dialog-instruction">扫码后在电脑上确认连接</div>
              {pair.kind === 'quick' && <div className="pair-dialog-meta">临时入口 · 地址变化后需要重新配对</div>}
            </div>
            {left <= 0 && (
              <div className="pair-dialog-actions"><button type="button" disabled={qrBusy || !selected || loadError} onClick={() => void showQr()}>{qrBusy ? '生成中…' : '重新生成'}</button></div>
            )}
            {left > 0 && (
              <details className="pair-help">
                <summary>扫码遇到问题？</summary>
                <div className="pair-help-content">
                  <div className="pair-origin">{new URL(pair.url).origin}</div>
                  <div>这里只能检查电脑端入口，手机还需要自行连通。</div>
                  {selected?.verification.state === 'failed' && <div className="pair-help-warning" role="status">{status.note}</div>}
                  {selected?.verification.state === 'passed' && <div>电脑端已通过检查，请确认手机网络。</div>}
                  <button type="button" className="secondary" disabled={!selected || checking || loadError} onClick={() => void probeSelected()}>{checking ? '检测中…' : '检查入口'}</button>
                </div>
              </details>
            )}
          </div>
        </Modal>
      )}
    </>
  );

}
