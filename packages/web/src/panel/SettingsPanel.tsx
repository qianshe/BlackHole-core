// Authoritative settings page tree for Web and the VS Code webview.
// Hosts supply transport and native-only capabilities, not a second page renderer.
import { settingsHost } from '../settings/host';
import { HostRuntimeSection } from '../settings/HostRuntimeSection';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { accountSummary, formatRemaining } from '../../../contracts/src/account-summary';
import { VERSION } from '../../../../src/version';
import {
  api, ApiError, panel, request,
  type AccountView, type BillingOrder, type BillingPlan, type BillingSku, type CourierSiteView, type GrantsInfo, type Health, type DirectAccessView,
  type ProxiesInfo, type ProxyConfigRow, type ProxyToolsResult, type RevalidateReport, type SemanticInfo, type SettingsValues, type SettingsView,
} from '../api';
import { ServiceCard } from '../AccountCard';
import { SettingsIcon } from '../ui';
import './panel.css';
import { OPENAI_TUNNEL_ID } from './openaiCopy';
import { OpenAISection, openaiStatus } from './OpenAISection';
import { RemoteSection } from './RemoteSection';
import { HomeChannelCard } from './HomeChannelCard';
import { chooseCurrentDirectAddress } from '../directAddressPicker';
import { copyText, Modal } from '../console/common';
import type { SettingsSection } from '../format';

type TextKey = 'cloudflaredPath' | 'publicBaseUrl' | 'directAccessUrl' | 'tunnelProbeProxy' | 'channelProxyUrl' | 'gitUsrBinPath' | 'skillsDir' | 'connectorName' | 'namedTunnelName' | 'openaiTunnelClientPath' | 'openaiTunnelId';
const FIELD: Record<TextKey, { label: string; desc: string; ph: string }> = {
  cloudflaredPath: { label: 'cloudflared 路径', desc: '公网渠道需要 cloudflared。安装后填写可执行文件的完整路径。', ph: 'cloudflared 可执行文件的完整路径' },
  publicBaseUrl: { label: '公网地址', desc: '填写 HTTP(S) Base URL；BlackHole 会自动生成 MCP 链接。HTTP 为明文传输。', ph: 'https://blackhole.example.com' },
  directAccessUrl: { label: '对外访问地址（可选）', desc: '复制给 Agent 的 HTTP(S) 地址；留空使用自动发现的本机地址。保存地址不会开启直连。', ph: 'https://bh.example.com 或 http://你的公网IP:7307' },
  channelProxyUrl: { label: '渠道应用代理（可选）', desc: '用于支持的渠道请求、安装和检测；已运行的 OpenAI 渠道重启后采用新代理。不是系统代理，也不保证 Cloudflare 数据隧道经过它。', ph: 'http://127.0.0.1:7890' },
  tunnelProbeProxy: { label: '公网连通性检测代理', desc: '通常留空，仅影响公网检测。渠道应用代理已设置时优先使用它；修改此项后需重启本地服务。', ph: '通常留空，例如 http://127.0.0.1:7897' },
  gitUsrBinPath: { label: 'GNU 工具目录 (Git usr/bin)', desc: 'grep/sed/awk/find 所在目录（Git for Windows 安装目录下的 usr/bin）。会加入 BlackHole exec/process 的 PATH，但不会把 shell 切换为 Bash；留空则不改 PATH。', ph: '例如 C:\\Program Files\\Git\\usr\\bin' },
  skillsDir: { label: '自定义 Skill 目录', desc: '留空使用 ~/.agents/skills。填写后替代这个默认库；项目里的 .agents/skills 仍然有效且优先。建议填绝对路径或 ~/ 开头的路径。', ph: '~/.agents/skills' },
  connectorName: { label: '连接器名称', desc: '复制连接器提示词时 @提及的名字。多人共用一个网页 AI 账号时，各自起名区分自己的连接器。留空 = BlackHole。', ph: 'BlackHole' },
  namedTunnelName: { label: 'named tunnel 名称', desc: '持久渠道执行的 cloudflared tunnel run <名称>。', ph: '例如 blackhole' },
  openaiTunnelClientPath: { label: 'tunnel-client 路径', desc: 'OpenAI 官方 tunnel-client（纯 runtime 版）可执行文件的完整路径。启动 OpenAI 渠道只使用这里保存的路径；留空时「一键安装」会依次查找 PATH 与一键安装目录，验证后自动保存，无需重启 daemon。', ph: '留空可一键安装' },
  openaiTunnelId: { label: 'Tunnel ID', desc: '在 OpenAI Platform 的隧道设置中复制的 Tunnel ID（不是 URL，也不是密钥）。', ph: 'tunnel_…' },
};
const TEXT_KEYS = Object.keys(FIELD) as TextKey[];
const NATIVE_MANUAL: Partial<Record<TextKey, SettingsSection>> = { cloudflaredPath: 'connections', publicBaseUrl: 'connections', tunnelProbeProxy: 'network', skillsDir: 'agents', gitUsrBinPath: 'advanced', namedTunnelName: 'advanced' };
const SEM_MODES = [
  { v: 'off', t: '关闭', title: '彻底不提供语义搜索' },
  { v: 'explicit', t: '手动', title: '使用下方保存的 key 或环境变量里的 key' },
  { v: 'auto', t: '自动', title: 'daemon 每次启动读取本机已登录的 Devin/Windsurf 凭据' },
] as const;
const ADVANCED_EDIT_KEYS = ['surface', 'risk', 'approvalUnits', 'redactPaths', 'sensitiveKeys', 'limits', 'browser'];
const STATUS_NAMES: Record<BillingOrder['status'], string> = { payment_pending: '待付款 / 待确认', paid: '付款已确认，权益处理中', fulfilled: '已到账', expired: '支付窗口已结束', review: '超时付款，未交付权益', refunded: '已退款' };
const BILLING_ERRORS: Record<string, string> = {
  payment_not_available: '支付宝时长购买尚未开放或当前配置不可用；现有登录、订阅卡兑换不受影响。',
  payment_result_unknown: '购买结果暂时无法确认。请从“购买记录”核对原订单，不要重复付款。',
  payment_review_required: '这笔订单需要管理员人工核对。请保留订单 ID，不要再次付款。',
  refund_not_available: '退款服务或当前支付配置暂不可用。',
  refund_quote_changed: '退款报价或权益状态已变化，本次未提交退款。请重新选择订单、查看金额并确认。',
  refund_not_eligible: '这笔订单当前不符合退款条件：可能尚未完成结算、没有剩余付费时长，或不属于当前账号。',
  refund_result_unknown: '退款结果暂时无法确认。请稍后从设置页再次选择同一订单核对；服务端会复用原退款请求，不要另外创建退款。',
  rate_limited: '请求较多，请稍后从购买记录继续。',
  rejected: '当前登录已变化，请重新登录购买账号后再核对。',
};
const days = (s: number) => Math.max(1, Math.round(s / 86400));
const price = (m: number) => '¥' + (m / 100).toFixed(2);
const durationLabel = (s: number) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.ceil((s % 3600) / 60); return [d ? d + ' 天' : '', h ? h + ' 小时' : '', m ? m + ' 分钟' : ''].filter(Boolean).join(' ') || '不足 1 分钟'; };
const planLabel = (p: BillingPlan) => `${p.amountMinor === 1 ? '支付验收 · ' : ''}${days(p.durationSeconds)} 天 · ${price(p.amountMinor)}`;
const orderLabel = (o: BillingOrder) => `${days(o.durationSeconds)} 天 · ${price(o.amountMinor)} · ${STATUS_NAMES[o.status]}`;
const DEFAULT_PLANS: { sku: BillingSku; label: string }[] = [{ sku: 'pro_day', label: '1 天 · ¥1.00' }, { sku: 'pro_week', label: '7 天 · ¥5.00' }, { sku: 'pro_month', label: '30 天 · ¥15.00' }];
const errText = (e: unknown) => (e instanceof ApiError ? e.detail || e.message || e.code : e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const copy = copyText;
function httpOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

// ─── in-page notifications and dialogs ─────────────────────────────────────
type Tone = 'info' | 'warn' | 'bad';
type PickItem = { label: string; description?: string; value: string };
type Dialog =
  | { kind: 'confirm'; title: string; detail?: ReactNode; actions: string[]; resolve: (v: string | null) => void }
  | { kind: 'pick'; title: string; items: PickItem[]; resolve: (v: string | null) => void }
  | { kind: 'input'; title: string; placeholder?: string; action: string; resolve: (v: string | null) => void };
type DistOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

function useUi() {
  const [toasts, setToasts] = useState<{ id: number; tone: Tone; text: string }[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const seq = useRef(0);
  const toast = useCallback((text: string, tone: Tone = 'info') => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'info' ? 5000 : 9000);
  }, []);
  const ask = (d: DistOmit<Dialog, 'resolve'>) => new Promise<string | null>((resolve) => setDialog({ ...d, resolve } as Dialog));
  const confirm = (title: string, actions: string[], detail?: ReactNode) => ask({ kind: 'confirm', title, actions, detail });
  const pick = (title: string, items: PickItem[]) => ask({ kind: 'pick', title, items });
  const input = (title: string, action: string, placeholder?: string) => ask({ kind: 'input', title, action, placeholder });
  const close = useCallback((v: string | null) => { setDialog((d) => { d?.resolve(v); return null; }); }, []);
  const node = (
    <>
      {dialog && <DialogView dialog={dialog} close={close} />}
      <div className="bhp-toast" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={t.tone}><span>{t.text}</span><button type="button" aria-label="关闭" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>×</button></div>)}
      </div>
    </>
  );
  return { toast, confirm, pick, input, node };
}
type Ui = ReturnType<typeof useUi>;

function DialogView({ dialog, close }: { dialog: Dialog; close: (v: string | null) => void }) {
  const [text, setText] = useState('');
  const first = useRef<HTMLButtonElement | HTMLInputElement | null>(null);
  useEffect(() => { first.current?.focus(); }, [close]);
  return (
    <Modal label={dialog.title} onClose={() => close(null)} className="buy-dialog">
        <div className="buy-dialog-head">
          <div className="buy-dialog-eyebrow">BLACKHOLE</div>
          <div className="buy-dialog-title" id="bhpDialogTitle">{dialog.title}</div>
        </div>
        {dialog.kind === 'confirm' && dialog.detail && <div className="buy-dialog-body">{dialog.detail}</div>}
        {dialog.kind === 'pick' && (
          <div className="buy-dialog-body"><div className="bhp-pick">
            {dialog.items.map((it, i) => (
              <button key={it.value} type="button" ref={i === 0 ? (el) => { first.current = el; } : undefined} onClick={() => close(it.value)}>
                <span>{it.label}</span>{it.description && <small>{it.description}</small>}
              </button>
            ))}
          </div></div>
        )}
        {dialog.kind === 'input' && (
          <div className="buy-dialog-body">
            <input name="bhp-prompt" className="bhp-input" ref={(el) => { first.current = el; }} value={text} placeholder={dialog.placeholder} spellCheck={false} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) close(text.trim()); }} />
          </div>
        )}
        <div className="buy-dialog-actions">
          <button type="button" className="secondary" onClick={() => close(null)}>取消</button>
          {dialog.kind === 'confirm' && dialog.actions.map((a, i) => (
            <button key={a} type="button" className={i < dialog.actions.length - 1 ? 'secondary' : ''} ref={i === dialog.actions.length - 1 ? (el) => { first.current = el; } : undefined} onClick={() => close(a)}>{a}</button>
          ))}
          {dialog.kind === 'input' && <button type="button" disabled={!text.trim()} onClick={() => close(text.trim())}>{dialog.action}</button>}
        </div>
    </Modal>
  );
}

// ─── activity (7 days) ─────────────────────────────────────────────────────
function Activity({ health }: { health: Health | null }) {
  const [tip, setTip] = useState<{ text: string; left: number; top: number } | null>(null);
  const stats = health?.stats ?? null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const unique = new Map<number, { start: number; total: number; added: number; removed: number }>();
  for (const d of health?.activity_days ?? []) if (d && Number.isFinite(d.start)) unique.set(d.start, { start: d.start, total: n(d.total), added: n(d.diff_added), removed: n(d.diff_removed) });
  const list = [...unique.values()].sort((a, b) => a.start - b.start).slice(-7);
  const today = stats ? '今日 ' + n(stats.total) + ' 次 · +' + n(stats.diff_added) + ' −' + n(stats.diff_removed) + ' 行' : '等待本地服务';
  const show = (el: HTMLElement, text: string) => { const r = el.getBoundingClientRect(); setTip({ text, left: Math.max(8, Math.min(r.left, window.innerWidth - 300)), top: r.bottom + 6 }); };
  useEffect(() => { const hide = () => setTip(null); window.addEventListener('scroll', hide, true); return () => window.removeEventListener('scroll', hide, true); }, []);
  return (
    <div className="cell wide" id="activity" aria-label={stats ? '活动：最近 7 天，本机统计' : '活动：本地服务未连接'}>
      <div className="activity-head ck-head"><div className="ck-k">活动</div><div className="activity-today ck-summary" title={today}>{today}</div></div>
      <div className="activity-track"><div className="activity-grid" role="group" aria-label="最近 7 天活动">
        {list.map((d) => {
          const date = new Date(d.start);
          const label = [date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日', d.total + ' 次工具调用', '+' + d.added + ' / −' + d.removed + ' 行'].join('\n');
          const level = d.total <= 0 ? 0 : Math.min(4, Math.floor(d.total / 1000) + 1);
          return <button key={d.start} type="button" className="activity-cell" data-level={String(level)} aria-label={label} aria-describedby="activityTooltip"
            onMouseEnter={(e) => show(e.currentTarget, label)} onMouseLeave={() => setTip(null)} onFocus={(e) => show(e.currentTarget, label)} onBlur={() => setTip(null)} onClick={(e) => show(e.currentTarget, label)} />;
        })}
      </div></div>
      <div id="activityTooltip" className="activity-tooltip" role="tooltip" hidden={!tip} style={tip ? { left: tip.left, top: tip.top } : undefined}>{tip?.text}</div>
    </div>
  );
}

// ─── the panel ─────────────────────────────────────────────────────────────
type Draft = Record<TextKey, string>;
type SaveKey = TextKey | 'channelMode' | 'aiDefaultRoute' | 'directAccessEnabled' | 'directPort' | 'semanticMode' | 'courierSites';
type FieldState = { state: 'saving' | 'saved' | 'error'; msg?: string };
const draftOf = (v: SettingsValues): Draft => Object.fromEntries(TEXT_KEYS.map((k) => [k, String((v as unknown as Record<string, unknown>)[k] ?? '')])) as Draft;
const serverText = (v: SettingsValues, k: TextKey) => String((v as unknown as Record<string, unknown>)[k] ?? '');
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;
/** Labels for pending_restart keys that are not text fields. */
const RESTART_LABELS: Record<string, string> = { channelMode: '渠道方式', semanticMode: 'Devin Key 模式', webAgents: '客户端站点选择', customWebAgents: '客户端自定义站点', remoteAccess: '手机访问' };
const restartLabel = (k: string) => (k in FIELD ? FIELD[k as TextKey].label : RESTART_LABELS[k] ?? k);

export function SettingsPanel({ page, account, onAccountChange, refreshAccount, onSignOut, onNavigate }: {
  page: SettingsSection;
  account: AccountView | null;
  onAccountChange: (view: AccountView | null) => void;
  refreshAccount: () => Promise<AccountView | null>;
  onSignOut: () => void;
  onNavigate?: (page: SettingsSection) => void;
}) {
  const ui = useUi();
  const [server, setServer] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [channelMode, setChannelMode] = useState<'cloudflare' | 'openai' | 'custom'>('cloudflare');
  const [directBusy, setDirectBusy] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const directFocusPending = useRef(false);
  const [semMode, setSemMode] = useState<string>('explicit');
  const [semKey, setSemKey] = useState('');
  const [health, setHealth] = useState<Health | null>(null);
  const [reachable, setReachable] = useState(true);
  const [semantic, setSemantic] = useState<SemanticInfo | null | undefined>(undefined);
  const [skills, setSkills] = useState<{ cls: string; hint: string } | null>(null);
  const [customProbe, setCustomProbe] = useState<{ url: string; state: 'idle' | 'probing' | 'online' | 'error'; detail: string }>({ url: '', state: 'idle', detail: '' });
  const [cf, setCf] = useState<{ busy: boolean; label: string; cls: string; text: string }>({ busy: false, label: '一键初始化安装', cls: 'hint', text: '准备并验证 cloudflared；验证后可选择保存并重启 daemon，不会自动启动渠道。' });
  const [grants, setGrants] = useState<GrantsInfo | null>(null);
  const [fstate, setFstateView] = useState<Partial<Record<SaveKey, FieldState>>>({});
  const [restarting, setRestarting] = useState(false);
  const modeRef = useRef(channelMode);
  modeRef.current = channelMode;
  useEffect(() => {
    if (!directBusy && directFocusPending.current) {
      directFocusPending.current = false;
      document.getElementById('directAccessToggle')?.focus({ preventScroll: true });
    }
  }, [directBusy]);

  // Async saves read the latest values through refs, never through a stale render.
  const serverRef = useRef<SettingsView | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const fstateRef = useRef<Partial<Record<SaveKey, FieldState>>>({});
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const inflight = useRef(new Set<Promise<boolean>>());
  const putDraft = (next: Draft) => { draftRef.current = next; setDraft(next); };
  const markField = (keys: SaveKey[], s: FieldState | null) => {
    const next = { ...fstateRef.current };
    for (const k of keys) { if (s) next[k] = s; else delete next[k]; }
    fstateRef.current = next;
    setFstateView(next);
  };

  /**
   * Adopt a server view. Fields just committed take the saved value unless the user
   * kept typing; `force` fields take it unconditionally; untouched fields follow the server.
   */
  const applyServer = (next: SettingsView, committed: Partial<Record<TextKey, string>> = {}, force: SaveKey[] = []) => {
    const prev = serverRef.current;
    if (prev && next.revision < prev.revision) return; // A late poll must not roll back a saved edit.
    serverRef.current = next;
    setServer(next);
    const d = draftRef.current;
    if (!d || !prev) putDraft(draftOf(next.values));
    else {
      const out = { ...d };
      for (const k of TEXT_KEYS) {
        const sent = committed[k];
        if (force.includes(k) || (sent !== undefined ? d[k].trim() === sent : d[k] === serverText(prev.values, k))) out[k] = serverText(next.values, k);
      }
      putDraft(out);
    }
    if (!prev || force.includes('channelMode')) setChannelMode(next.values.channelMode);
    else setChannelMode((m) => (m === prev.values.channelMode ? next.values.channelMode : m));
    if (!prev || force.includes('semanticMode')) setSemMode(next.values.semanticMode);
    else setSemMode((m) => (m === prev.values.semanticMode ? next.values.semanticMode : m));
  };

  /** Save some values, one request at a time; retry once over a revision bump that touched other keys. */
  const commit = (values: Partial<SettingsValues>, keys: SaveKey[], committed: Partial<Record<TextKey, string>> = {}, expected?: SettingsView): Promise<boolean> => {
    markField(keys, { state: 'saving' });
    const task = async (): Promise<boolean> => {
      try {
        let base = expected ?? serverRef.current ?? (await api.settings());
        for (let attempt = 0; ; attempt++) {
          try {
            applyServer(await api.saveSettings(base.revision, values), committed);
            markField(keys, { state: 'saved' });
            setTimeout(() => { if (keys.every((k) => fstateRef.current[k]?.state === 'saved')) markField(keys, null); }, 2500);
            return true;
          } catch (e) {
            if (!(e instanceof ApiError) || e.code !== 'revision_conflict' || expected || attempt > 0) throw e;
            const fresh = await api.settings();
            const changed = (Object.keys(values) as (keyof SettingsValues)[]).filter((k) => JSON.stringify(fresh.values[k]) !== JSON.stringify(base.values[k]));
            if (changed.length) {
              applyServer(fresh);
              markField(keys, { state: 'error', msg: '这一项已在别处修改，本次未覆盖；已保留你的输入，请核对后重试。' });
              return false;
            }
            applyServer(fresh);
            base = fresh;
          }
        }
      } catch (e) {
        markField(keys, { state: 'error', msg: '保存失败：' + errText(e) });
        return false;
      }
    };
    const run = chain.current.then(task, task);
    chain.current = run;
    inflight.current.add(run);
    void run.finally(() => inflight.current.delete(run));
    return run;
  };

  const validate = (k: TextKey, v: string): string | null => {
    if (k === 'publicBaseUrl' && modeRef.current === 'custom' && !v) return '自定义公网入口需要填写 HTTP(S) 地址。';
    if ((k === 'directAccessUrl' || k === 'publicBaseUrl') && v && !httpOrigin(v)) return '请填写不带路径、凭据或查询参数的 HTTP(S) 地址。';
    if (k === 'channelProxyUrl' && v && !/^https?:\/\/[^\s/]+:\d+\/?$/i.test(v)) return '渠道应用代理应为带端口的 HTTP(S) 地址，例如 http://127.0.0.1:7890；暂不接收带凭据 URL。';
    if (k === 'openaiTunnelId' && v && !OPENAI_TUNNEL_ID.test(v)) return 'Tunnel ID 应为 OpenAI Platform 隧道设置中的 ID（tunnel_ 加 32 位小写十六进制），不是 URL。';
    if (k === 'openaiTunnelClientPath' && v && !ABSOLUTE_PATH.test(v)) return 'tunnel-client 路径需要填写可执行文件的绝对路径，或留空。';
    return null;
  };
  /** Blur / Enter: save the field if it differs from the daemon. */
  const commitText = (k: TextKey): Promise<boolean> => {
    const d = draftRef.current, s = serverRef.current;
    if (!d || !s) return Promise.resolve(false);
    const next = d[k].trim();
    // Custom mode is saved together with its first valid HTTPS address.
    const withMode = k === 'publicBaseUrl' && modeRef.current === 'custom' && s.values.channelMode !== 'custom';
    if (next === serverText(s.values, k) && !withMode) { if (fstateRef.current[k]?.state === 'error') markField([k], null); return Promise.resolve(true); }
    const bad = validate(k, next);
    if (bad) { markField([k], { state: 'error', msg: bad }); return Promise.resolve(false); }
    if (settingsHost().kind === 'vscode' && NATIVE_MANUAL[k]) return Promise.resolve(true);
    const values = (withMode ? { publicBaseUrl: next, channelMode: 'custom' } : { [k]: next }) as Partial<SettingsValues>;
    return commit(values, withMode ? [k, 'channelMode'] : [k], { [k]: next } as Partial<Record<TextKey, string>>);
  };
  const revertText = (k: TextKey) => {
    const d = draftRef.current, s = serverRef.current;
    if (d && s) putDraft({ ...d, [k]: serverText(s.values, k) });
    markField([k], null);
  };
  const dirtyKeys = () => {
    const d = draftRef.current, s = serverRef.current;
    return d && s ? TEXT_KEYS.filter((k) => d[k].trim() !== serverText(s.values, k)) : [];
  };

  const loadSettings = useCallback(async () => {
    const s = await api.settings();
    applyServer(s);
    setSemKey('');
    setCustomProbe({ url: '', state: 'idle', detail: '' });
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const loadSemantic = useCallback(() => { panel.semantic().then(setSemantic, () => setSemantic(null)); }, []);
  const loadGrants = useCallback(() => { panel.grants().then(setGrants, () => undefined); }, []);

  useEffect(() => {
    void loadSettings().catch((e: unknown) => ui.toast('读取设置失败：' + errText(e), 'bad'));
    loadSemantic();
    loadGrants();
    let stop = false;
    void (async () => {
      while (!stop) {
        try {
          const h = await panel.health();
          if (stop) break;
          setHealth(h); setReachable(true);
          if (!inflight.current.size && h.settings_revision !== undefined && h.settings_revision !== serverRef.current?.revision) {
            const next = await api.settings();
            if (!stop) applyServer(next);
          }
        } catch { if (!stop) setReachable(false); }
        await sleep(2000);
      }
    })();
    // Blur/Enter commits explicitly; leaving must not launch a second save from cleanup.
    const onUnload = (e: BeforeUnloadEvent) => { if (inflight.current.size || dirtyKeys().length) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      stop = true;
      window.removeEventListener('beforeunload', onUnload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skillsDir = draft?.skillsDir;
  useEffect(() => {
    if (skillsDir === undefined) return;
    const t = setTimeout(() => { panel.skills(skillsDir.trim()).then(setSkills, () => setSkills(null)); }, 300);
    return () => clearTimeout(t);
  }, [skillsDir]);

  const set = (k: TextKey, v: string) => { if (draftRef.current) putDraft({ ...draftRef.current, [k]: v }); };

  // ── status (renderStatus) ──
  const o = health;
  const t = reachable ? o?.tunnel : 'unreachable';
  const dm: [string, string] = reachable ? ['ok', '运行中' + (o?.version ? ' · v' + o.version : '')] : ['', '未运行'];
  const aiDefaultRoute = server?.values.aiDefaultRoute ?? 'auto';
  const directEnabled = server?.values.directAccessEnabled === true;
  const routes = reachable ? o?.connection_routes : null;
  const routeName = routes?.selected_route === 'direct' ? '直连' : routes?.selected_route === 'openai' ? 'OpenAI Tunnel' : routes?.selected_route === 'custom' ? '自定义公网入口' : 'Cloudflare';
  const connectionNote = !reachable ? '本地服务未连接' : !routes ? '正在读取连接状态…' : routes.needs_choice ? '已发现多个直连地址，复制时选择目标 Agent 能访问的地址。' : routes.connector_ready ? '默认连接已配置；网络可达性以目标客户端实际连接为准。' : '当前默认入口未就绪；不会自动改用其他渠道。';
  const oaSt = openaiStatus(reachable ? health : null, reachable, draft?.openaiTunnelClientPath ?? '');
  const hasNamed = !!o?.public_base_url;
  let chst: { text: string; cls: string };
  let cnerr: { text: string; cls: string } | null = null;
  let showQ = true, showN = true, showS = false, showC = false;
  if (channelMode === 'custom') {
    showQ = showN = false;
    const s = customProbe.state === 'online' ? ['自定义 · 在线', 'ok'] : customProbe.state === 'probing' ? ['检测中…', 'warn'] : customProbe.state === 'error' ? ['自定义 · 不可达', 'bad'] : ['待检测', 'dim'];
    chst = { text: s[0]!, cls: s[1]! };
    if (customProbe.detail) cnerr = { text: customProbe.detail, cls: customProbe.state === 'error' ? 'bad' : '' };
  } else if (t === 'online' || t === 'unverified') {
    chst = { text: (t === 'online' ? '在线 · ' : '未验证 · ') + (o?.tunnel_mode === 'named' ? '持久' : '临时'), cls: t === 'online' ? 'ok' : 'warn' };
    if (o?.tunnel_reason) cnerr = { text: o.tunnel_reason, cls: 'warn' };
    showS = showC = true; showQ = showN = false;
  } else if (t === 'starting') {
    chst = { text: '启动中…', cls: 'warn' };
    if (o?.tunnel_reason) cnerr = { text: o.tunnel_reason, cls: 'warn' };
    showQ = showN = false; showS = true;
  } else if (t === 'error' || t === 'unavailable') {
    chst = { text: t === 'error' ? '启动失败' : '不可用', cls: 'bad' };
    if (o?.tunnel_reason) cnerr = { text: o.tunnel_reason, cls: 'bad' };
    showS = true;
  } else if (t === 'unreachable') {
    chst = { text: 'daemon 未运行', cls: 'dim' }; showQ = showN = false;
  } else chst = { text: '未启动', cls: 'dim' };
  const customReady = channelMode === 'custom' && customProbe.state === 'online' && !!customProbe.url;
  const mcpValue = reachable ? (o?.connection_routes?.preferred_mcp_url ?? (!o?.connection_routes ? o?.mcp_url || '' : '')) : '';
  const selectedOpenAI = o?.connection_routes ? o.connection_routes.selected_route === 'openai' || o.connection_routes.reason === 'openai_selected' : channelMode === 'openai';
  // A loopback link works on this computer only: copyable, but not "ready".
  const mcpLocal = /:\/\/(127\.|localhost|\[::1\])/.test(mcpValue);
  const savedTunnelId = o?.connection_routes ? o.connection_routes.saved_tunnel_id ?? '' : server?.values.openaiTunnelId ?? '';

  // ── actions ──
  const refreshHealth = () => { panel.health().then(setHealth, () => undefined); };
  const requireCloudflaredPath = () => {
    if (serverRef.current?.values.cloudflaredPath.trim()) return true;
    ui.toast('使用公网渠道前，请先填写 cloudflared 可执行文件的完整路径。', 'warn');
    document.getElementById('cloudflaredPath')?.focus();
    return false;
  };
  const tunnel = async (action: 'quick' | 'named' | 'stop' | 'copy') => {
    if (action === 'copy') {
      if (o?.tunnel_url && (await copy(o.tunnel_url))) ui.toast('BlackHole：公网渠道地址已复制。');
      else ui.toast('BlackHole：当前没有可复制的公网渠道地址。', 'warn');
      return;
    }
    try {
      if (action === 'stop') { await panel.tunnelStop(); ui.toast('BlackHole：公网渠道已停止。'); }
      else { await panel.tunnelStart(action); ui.toast(`BlackHole：${action === 'quick' ? '临时' : '持久'}公网渠道已启动。`); }
    } catch (e) { ui.toast('BlackHole: 渠道操作失败 — ' + errText(e), 'bad'); }
    refreshHealth();
  };
  const runCustomProbe = async () => {
    const entered = draft?.publicBaseUrl.trim() ?? '';
    const url = entered.endsWith('/') ? entered.slice(0, -1) : entered;
    if (!url) { ui.toast('请先填写当前公网地址。', 'warn'); document.getElementById('customPublicBaseUrl')?.focus(); return; }
    setCustomProbe({ url, state: 'probing', detail: '' });
    const r = await api.probePublicUrl(url).catch(() => ({ ok: false, detail: '公网地址不可达' }));
    setCustomProbe((p) => (p.url === url ? { url, state: r.ok ? 'online' : 'error', detail: r.ok ? '' : r.detail || '公网地址不可达' } : p));
  };
  const pickChannel = (m: 'cloudflare' | 'openai' | 'custom') => {
    const s = serverRef.current;
    setCustomProbe({ url: '', state: 'idle', detail: '' });
    setChannelMode(m);
    if (!s) return;
    if (m === s.values.channelMode) { markField(['channelMode'], null); return; }
    // Custom needs its HTTP(S) address first; the mode is saved with it (commitText).
    if (m === 'custom' && !/^https?:\/\/[^\s/]+/i.test((draftRef.current?.publicBaseUrl ?? '').trim())) {
      markField(['channelMode'], { state: 'error', msg: '填写并保存 HTTP(S) 公网地址后，自定义渠道才会成为默认渠道。' });
      return;
    }
    if (m === 'custom' && settingsHost().kind === 'vscode' && (draftRef.current?.publicBaseUrl ?? '').trim() !== serverRef.current?.values.publicBaseUrl) {
      markField(['channelMode'], { state: 'error', msg: '公网地址尚未保存；点击「保存本页」同时应用地址和自定义渠道。' }); return;
    }
    void commit({ channelMode: m }, ['channelMode']).then((ok) => { if (!ok && serverRef.current) setChannelMode(serverRef.current.values.channelMode); });
  };
  const pickSemMode = (m: string) => {
    setSemMode(m);
    if (m === serverRef.current?.values.semanticMode || settingsHost().kind === 'vscode') return;
    void commit({ semanticMode: m as SettingsValues['semanticMode'] }, ['semanticMode']).then((ok) => { if (!ok && serverRef.current) setSemMode(serverRef.current.values.semanticMode); });
  };
  /** Restart in place and wait until a new daemon answers. */
  const restartAndWait = async (): Promise<boolean> => {
    const before = (await panel.health().catch(() => null))?.daemon_id;
    try { await panel.restart(); } catch { return false; }
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const h = await panel.health().catch(() => null);
      if (h && h.daemon_id !== before) { setHealth(h); return true; }
    }
    return false;
  };
  const cfInstall = async () => {
    if (channelMode !== 'cloudflare' || cf.busy || !server) return;
    const initialPath = server.values.cloudflaredPath, initialMode = server.values.channelMode, previous = draft?.cloudflaredPath ?? '';
    setCf({ busy: true, label: '初始化中…', cls: 'hint', text: '正在准备 cloudflared；验证后可选择保存并重启，不会自动启动渠道。' });
    const done = (cls: string, text: string) => setCf({ busy: false, label: '一键初始化安装', cls, text });
    try {
      let job = await panel.cloudflaredStart();
      while (job.state === 'running') { await sleep(1000); job = await panel.cloudflared(); }
      if (job.state === 'error') { done('hint bad', job.error); return; }
      if (job.state !== 'done') { done('hint bad', '初始化未完成'); return; }
      setCf({ busy: true, label: '等待确认…', cls: 'hint', text: 'cloudflared 验证通过，等待确认；尚未保存或启动渠道。' });
      const choice = await ui.confirm('BlackHole：cloudflared 验证通过。保存该路径，并重启 daemon 使其生效？', ['仅保存路径', '保存并重启'],
        <div className="buy-dialog-note" style={{ marginTop: 0 }}>{job.path}<br />重启会短暂中断本地服务；不会自动启动公网渠道。</div>);
      if (!choice) { done('hint', 'cloudflared 已就绪：' + job.path + '。未保存路径。'); return; }
      const latest = await api.settings();
      if (latest.values.channelMode !== initialMode || latest.values.cloudflaredPath !== initialPath || (draftRef.current?.cloudflaredPath ?? '') !== previous) {
        done('hint bad', `渠道配置已变化，未保存路径或重启 daemon。已验证文件：${job.path}`);
        return;
      }
      setCf({ busy: true, label: '正在保存…', cls: 'hint', text: '正在保存路径；不会自动启动渠道。' });
      set('cloudflaredPath', job.path);
      if (!(await commit({ cloudflaredPath: job.path }, ['cloudflaredPath'], { cloudflaredPath: job.path }))) { done('hint bad', '路径保存失败；请查看上面的输入框提示。'); return; }
      if (choice !== '保存并重启') { done('hint ok', (job.installed ? '安装完成。' : '已有可用的 cloudflared，未下载。') + '路径已保存，重启 daemon 后生效；尚未启动渠道。'); return; }
      setCf({ busy: true, label: '正在重启…', cls: 'hint', text: '路径已保存，正在重启 daemon；不会自动启动渠道。' });
      const restarted = await restartAndWait();
      if (restarted) await loadSettings().catch(() => undefined);
      done(restarted ? 'hint ok' : 'hint bad', restarted ? '路径已保存，daemon 已重启；尚未启动渠道。' : '路径已保存，但 daemon 重启失败。');
    } catch (e) { done('hint bad', errText(e)); }
  };
  const restart = async () => {
    if (restarting) return;
    if ((await ui.confirm('BlackHole：重启 daemon 会短暂中断本地服务，已连接的网页 AI 需要等它恢复。', ['重启'])) !== '重启') return;
    setRestarting(true);
    await Promise.allSettled([...inflight.current]);
    const ok = await restartAndWait();
    setRestarting(false);
    if (ok) { ui.toast('BlackHole：daemon 已重启。'); await loadSettings().catch(() => undefined); loadSemantic(); }
    else ui.toast('BlackHole：重启 daemon 失败', 'bad');
  };
  const rotateToken = async () => {
    if ((await ui.confirm('BlackHole: 重置后旧 MCP 链接立即失效，连接器/沙箱脚本里配置的旧地址全部要换成新链接（会话 ID 不受影响）。确认重置？', ['重置'])) !== '重置') return;
    try {
      const r = await panel.rotateToken();
      const next = r.connection_routes?.preferred_mcp_url ?? (!r.connection_routes ? r.mcp_url : null);
      if (next) {
        await copy(next);
        ui.toast('BlackHole：MCP 链接已重置，当前选中入口的新链接已复制；请更新已配置的客户端。');
      } else {
        ui.toast('BlackHole：MCP 链接已重置。当前入口需要选择或没有 URL，请确认连接后再复制。', 'warn');
      }
    } catch (e) { ui.toast('BlackHole: 刷新 token 失败 — ' + errText(e), 'bad'); }
    refreshHealth();
  };
  const copyDesc = async () => {
    const ok = await copy(['BlackHole provides access to the current workspace through MCP.', 'Start with guide using the supplied sessionId. Comply with its instructions throughout the session, and use that sessionId on every BlackHole call.'].join('\n'));
    ui.toast(ok ? 'BlackHole：连接器描述已复制。' : '复制失败，请重试。', ok ? 'info' : 'warn');
  };
  const grantRemove = async (scope: 'always' | 'session', key: string, sessionId?: string) => {
    if ((await ui.confirm(`BlackHole：删除这条${scope === 'session' ? '会话' : '全局'}授权后，相关操作会重新询问。`, ['删除授权'])) !== '删除授权') return;
    try {
      if (scope === 'session') await panel.sessionGrantRemove(sessionId ?? '', key); else await panel.grantRemove(key);
      loadGrants();
      ui.toast('BlackHole：授权已删除。');
    } catch (e) { ui.toast('BlackHole: 删除授权失败 — ' + errText(e), 'bad'); }
  };
  const grantsClear = async () => {
    if ((await ui.confirm('BlackHole：清除全部全局授权后，相关操作会重新询问。', ['清除全部'])) !== '清除全部') return;
    try { await panel.grantsClear(); loadGrants(); ui.toast('BlackHole：全部全局授权已清除。'); }
    catch (e) { ui.toast('BlackHole: 清除授权失败 — ' + errText(e), 'bad'); }
  };
  const semanticSave = async () => {
    const key = semKey.trim();
    if (!key) return;
    try { await panel.semanticSave(key); setSemKey(''); ui.toast('BlackHole：Devin Key 已保存；重启 daemon 后生效。'); }
    catch (e) { ui.toast('BlackHole: Devin Key 保存失败 — ' + errText(e), 'bad'); }
    loadSemantic();
  };
  const semanticClear = async () => {
    if ((await ui.confirm('BlackHole：清除 Devin Key 后，重启 daemon 会使 context_search 下线。', ['清除 Key'])) !== '清除 Key') return;
    try { await panel.semanticClear(); ui.toast('BlackHole：Devin Key 已清除；重启 daemon 后 context_search 下线。'); }
    catch (e) { ui.toast('BlackHole: 清除失败 — ' + errText(e), 'bad'); }
    loadSemantic();
  };
  /** OpenAI start: pending saves land first, then the daemon must hold exactly the fields shown. */
  const prepareOpenaiStart = async (): Promise<number> => {
    const keys: TextKey[] = ['openaiTunnelClientPath', 'openaiTunnelId'];
    for (const k of keys) if (dirtyKeys().includes(k)) void commitText(k);
    await Promise.allSettled([...inflight.current]);
    if (keys.some((k) => fstateRef.current[k]?.state === 'error' || dirtyKeys().includes(k))) throw new Error('unsaved_settings');
    const fresh = await api.settings();
    const d = draftRef.current!;
    const diff = Object.fromEntries(keys.filter((k) => serverText(fresh.values, k).trim() !== d[k].trim()).map((k) => [k, d[k].trim()])) as Partial<Record<TextKey, string>>;
    if (!Object.keys(diff).length) return fresh.revision;
    applyServer(fresh);
    if (!(await commit(diff as Partial<SettingsValues>, keys, diff))) throw new Error('unsaved_settings');
    return serverRef.current!.revision;
  };
  const openaiInstalled = async (previous: string, path: string): Promise<boolean> => {
    await Promise.allSettled([...inflight.current]);
    const s = serverRef.current;
    if (!s || (draftRef.current?.openaiTunnelClientPath ?? '') !== previous || serverText(s.values, 'openaiTunnelClientPath') !== previous.trim()) return false;
    set('openaiTunnelClientPath', path);
    return commit({ openaiTunnelClientPath: path }, ['openaiTunnelClientPath'], { openaiTunnelClientPath: path });
  };

  /** Delete a Courier site: saved at once; Courier then unbinds it, stops injecting and drops the host permission. */
  const removeCourierSite = async (id: string) => {
    const site = serverRef.current?.values.courierSites?.find((x) => x.id === id);
    if (!site) return;
    const ok = await ui.confirm(`BlackHole：删除 Courier 网页站点「${site.name}」？浏览器里的 Courier 会解除它的绑定、停止接管 ${site.origin} 并收回访问权限。`, ['删除']);
    if (ok !== '删除') return;
    const rest = (serverRef.current?.values.courierSites ?? []).filter((x) => x.id !== id);
    if (await commit({ courierSites: rest }, ['courierSites'])) ui.toast(`已删除「${site.name}」`);
  };

  // One switch controls direct listening. An advertised address is optional and
  // is saved atomically with enable; disabling never discards an address draft.
  const directLock = useRef(false);
  const toggleDirect = async (on: boolean) => {
    if (directLock.current || !serverRef.current) return;
    directLock.current = true; setDirectBusy(true);
    try {
      await Promise.allSettled([...inflight.current]);
      const before = serverRef.current ?? await api.settings();
      const entered = (draftRef.current?.directAccessUrl ?? '').trim();
      const url = entered ? httpOrigin(entered) : '';
      if (on && entered && !url) {
        markField(['directAccessUrl'], { state: 'error', msg: '请填写不带路径、凭据或查询参数的 HTTP(S) 地址。' });
        document.getElementById('directAccessUrl')?.focus(); return;
      }
      if (on && (await ui.confirm('开启直连？', ['开启'], '允许能到达本机直连端口的设备使用 MCP、引导页、手机与面板。HTTP 不加密；HTTPS 需自行配置 TLS 入口。MCP 和设备仍需认证，手机扫码后仍须在电脑上允许；本地管理接口不会开放。')) !== '开启') return;
      const confirmed = await api.settings();
      if ((['directAccessEnabled', 'directAccessUrl', 'directPort'] as const).some(key => confirmed.values[key] !== before.values[key])) {
        applyServer(confirmed);
        markField(['directAccessEnabled'], { state: 'error', msg: '直连设置已在别处修改，本次未覆盖。请核对后重试。' }); return;
      }
      const values: Partial<SettingsValues> = on ? { directAccessEnabled: true, directAccessUrl: url || '' } : { directAccessEnabled: false };
      if (await commit(values, on ? ['directAccessEnabled', 'directAccessUrl'] : ['directAccessEnabled'], on ? { directAccessUrl: entered } : {}, confirmed)) refreshHealth();
    } catch (e) {
      markField(['directAccessEnabled'], { state: 'error', msg: '直连操作未完成：' + errText(e) });
    } finally {
      directLock.current = false;
      directFocusPending.current = true;
      setDirectBusy(false);
    }
  };

  const copyConnection = async () => {
    if (copyBusy) return;
    setCopyBusy(true);
    try {
      const fresh = await panel.health();
      setHealth(fresh);
      const current = fresh.connection_routes;
      const openai = current?.selected_route === 'openai';
      const value = openai ? current.saved_tunnel_id : await chooseCurrentDirectAddress(fresh, panel.health);
      if (!value) {
        if (!current?.needs_choice) ui.toast(openai ? '尚未保存 Tunnel ID。' : '当前连接没有可用地址，未改用其他渠道。', 'warn');
        return;
      }
      const ok = await copy(value);
      ui.toast(ok ? '连接信息已复制。' : '复制失败，请重试。', ok ? 'info' : 'warn');
    } catch (e) { ui.toast(errText(e), 'warn'); }
    finally {
      setCopyBusy(false);
      requestAnimationFrame(() => document.getElementById('mcpCopy')?.focus({ preventScroll: true }));
    }
  };

  const fieldStatus = (k: SaveKey) => {
    const s = fstate[k];
    return s && s.state !== 'error' ? <span className={'bhp-fs ' + s.state}>{s.state === 'saving' ? '保存中…' : '已保存'}</span> : null;
  };
  const fieldError = (k: SaveKey) => { const s = fstate[k]; return s?.state === 'error' ? <div className="bhp-ferr" role="alert">{s.msg}</div> : null; };
  const textInput = (k: TextKey, id: string = k, disabled = false, onEdit?: () => void) => (
    <input id={id} type="text" spellCheck={false} value={draft?.[k] ?? ''} placeholder={FIELD[k].ph} disabled={disabled || !draft} aria-invalid={fstate[k]?.state === 'error' || undefined}
      onChange={(e) => { set(k, e.target.value); onEdit?.(); }}
      onBlur={() => void commitText(k)}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape' && (dirtyKeys().includes(k) || fstateRef.current[k]?.state === 'error')) { e.preventDefault(); e.stopPropagation(); revertText(k); } }} />
  );
  const field = (k: TextKey, extra?: ReactNode, disabled = false) => (
    <div className="f" key={k}>
      <label htmlFor={k}>{FIELD[k].label}{settingsHost().kind === 'vscode' && NATIVE_MANUAL[k] && <span className="rs">需重启</span>}{fieldStatus(k)}</label>
      {textInput(k, k, disabled)}
      {fieldError(k)}
      <div className="d">{FIELD[k].desc}</div>
      {extra}
    </div>
  );
  const semStatus: { text: string; cls: string; clear: boolean } = semantic === undefined ? { text: '…', cls: 'dim', clear: false }
    : !semantic ? { text: '（daemon 未运行）', cls: 'dim', clear: false }
    : semantic.registered ? { text: '已生效' + (semantic.registered_source === 'env' ? ' · 来自环境变量' : ' · ' + (semantic.registered_preview || '已配置')), cls: 'ok', clear: semantic.registered_source === 'file' }
    : semantic.would_resolve ? { text: '已保存 key · 重启 daemon 后生效', cls: 'warn', clear: true }
    : { text: '未配置', cls: 'dim', clear: false };
  const hasCfPath = (draft?.cloudflaredPath.trim() ?? '') !== '';
  const port = window.location.port || '7306';
  const restartPage: Record<string, SettingsSection> = {
    cloudflaredPath: 'connections', publicBaseUrl: 'connections', channelMode: 'connections',
    tunnelProbeProxy: 'network', skillsDir: 'agents', semanticMode: 'agents',
  };
  const pending = (server?.pending_restart ?? []).filter((key) => page === 'advanced' || restartPage[key] === page);
  const homeAccount = accountSummary(account);
  const directView = reachable ? o?.direct_access ?? null : null;
  const directUrl = (draft?.directAccessUrl ?? '').trim();
  const directOrigin = directUrl ? httpOrigin(directUrl) : null;
  const directTarget = directView?.target ?? `http://127.0.0.1:${server?.values.directPort ?? 7307}`;
  const homeIdentity = homeAccount.authState === 'logged_out' ? '未登录' : homeAccount.displayName;
  const homeRemaining = homeAccount.accountStatus === 'suspended' ? '账号已停用' : homeAccount.accountStatus === 'pending' ? '订阅准备中' : formatRemaining(homeAccount.remainingSeconds);
  const nativeHost = settingsHost().kind === 'vscode';
  const manualPageKeys = nativeHost ? TEXT_KEYS.filter(k => NATIVE_MANUAL[k] === page) : [];
  const manualDirty = manualPageKeys.filter(k => draft && server && draft[k].trim() !== serverText(server.values, k));
  const semanticDirty = nativeHost && page === 'agents' && server && semMode !== server.values.semanticMode;
  const saveNativePage = async () => {
    const s = serverRef.current, d = draftRef.current;
    if (!s || !d) return;
    const values: Partial<SettingsValues> = {}, committed: Partial<Record<TextKey, string>> = {}, keys: SaveKey[] = [];
    for (const k of manualDirty) {
      const value = d[k].trim(), bad = validate(k, value);
      if (bad) { markField([k], { state: 'error', msg: bad }); return; }
      Object.assign(values, { [k]: value }); committed[k] = value; keys.push(k);
    }
    if (page === 'connections' && modeRef.current === 'custom' && s.values.channelMode !== 'custom') { values.channelMode = 'custom'; keys.push('channelMode'); }
    if (semanticDirty) { values.semanticMode = semMode as SettingsValues['semanticMode']; keys.push('semanticMode'); }
    if (keys.length && await commit(values, keys, committed, s)) ui.toast('本页设置已保存；其他页面的草稿未提交。');
  };

  return (
    <div className={'bhp' + (page === 'home' ? ' bhp-home' : '')}>
      {page === 'home' && (
        <>
          <div className="cockpit" id="set-home">
            <div className="cell home-account">
              <div className="ck-head home-account-head">
                <div className="ck-k">账号</div>
                <span className="ck-summary home-account-remaining" title={homeRemaining}>{homeRemaining}</span>
              </div>
              <div className="ck-v home-account-row">
                <span className={'status-dot ' + (homeAccount.remainingSeconds === 0 ? 'bad' : homeAccount.remainingSeconds !== null && homeAccount.remainingSeconds < 3 * 86400 ? 'warn' : '')} aria-hidden="true" />
                <span className="home-account-name" title={homeAccount.email ?? homeIdentity}>{homeIdentity}</span>
                {homeAccount.canSignOut && <button type="button" className="home-signout" aria-label="退出登录" title="退出登录" onClick={onSignOut}><SettingsIcon name="logout" size={15} /></button>}
              </div>
            </div>
            <HomeChannelCard health={reachable ? health : null} mode={channelMode} toast={ui.toast} onRefresh={refreshHealth} />
            <Activity health={reachable ? health : null} />
          </div>
          <div className="card pair-card"><RemoteSection part="pair" toast={ui.toast} confirm={ui.confirm} onConfigure={onNavigate ? () => onNavigate('network') : undefined} /></div>
          <footer className="settings-home-version" aria-label={`BlackHole 版本 ${VERSION}`} title={`BlackHole v${VERSION}`}>v{VERSION}</footer>
        </>
      )}

      {page === 'account' && (
        <>
          <div className="sec" id="set-account">账号与订阅<small>登录状态、订阅时长与购买记录。</small></div>
          <AccountSection ui={ui} view={account} onView={onAccountChange} refreshAccount={refreshAccount} onSignOut={onSignOut} />
        </>
      )}

      {page === 'connections' && (
        <>
          <section className="connection-current" aria-label="当前连接">
            <div className="sec" id="set-current">当前连接</div>
            <div className="card" role="status"><strong>{routes ? `当前默认：${routeName}` : '连接状态待确认'}</strong><div className="hint">{connectionNote}</div></div>
          </section>
          <div className="sec" id="set-channel">公网渠道</div>
          <div className="card">
            <div className="channel-mode"><span className="lbl">渠道方式</span>
              {(['cloudflare', 'openai', 'custom'] as const).map((m) => (
                <button key={m} type="button" className={'agchip' + (channelMode === m ? ' on' : '')} aria-pressed={channelMode === m} disabled={!server || cf.busy}
                  onClick={() => pickChannel(m)}>{m === 'cloudflare' ? 'Cloudflare' : m === 'openai' ? 'OpenAI' : '自定义'}</button>
              ))}
              {fieldStatus('channelMode')}
            </div>
            {fieldError('channelMode')}
            {channelMode === 'cloudflare' ? (
              <div id="channelCloudflare">
                <div className="fgrid channel-config">{field('cloudflaredPath', undefined, cf.busy)}{field('publicBaseUrl')}</div>
                {(!hasCfPath || cf.cls !== 'hint') && <div className="channel-install runtime-install-row">
                  <div className="runtime-install-copy"><strong>cloudflared 安装</strong><div id="cfInstallMessage" className={cf.cls} role="status" aria-live="polite">{cf.text}</div></div>
                  {!hasCfPath && <button id="cfInstall" className="secondary" type="button" disabled={cf.busy} onClick={() => void cfInstall()}>{cf.label}</button>}
                </div>}
                <div className="channel-required">固定公网地址用于持久渠道；程序路径修改后需重启本地服务。</div>
              </div>
            ) : channelMode === 'openai' ? (
              <OpenAISection health={health} reachable={reachable} clientPath={draft?.openaiTunnelClientPath ?? ''}
                fields={(installing) => <>{field('openaiTunnelClientPath', undefined, installing)}{field('openaiTunnelId')}</>}
                confirm={ui.confirm} toast={ui.toast} prepareStart={prepareOpenaiStart} onInstalled={openaiInstalled} />
            ) : (
              <div id="channelCustom">
                <div className="fgrid channel-config"><div className="f">
                  <label htmlFor="customPublicBaseUrl">已有公网入口{fieldStatus('publicBaseUrl')}</label>
                  <div className="channel-probe-line">
                    {textInput('publicBaseUrl', 'customPublicBaseUrl', false, () => setCustomProbe({ url: '', state: 'idle', detail: '' }))}
                    <button className="secondary" type="button" disabled={customProbe.state === 'probing' || !reachable} onClick={() => void runCustomProbe()}>检测</button>
                  </div>
                  {fieldError('publicBaseUrl')}
                  <div className="d">已有反向代理或其他公网入口时填写，HTTP/HTTPS 均可。</div>
                </div></div>
                <div className="channel-custom-note">反向代理目标：<code>{directTarget}</code>，保留原始 Host。与直连共用一个数据端口，不要代理主 daemon 管理端口。</div>
              </div>
            )}
            {channelMode !== 'openai' && <div className="chrow channel-actions">
              <span className={'chst ' + chst.cls}>{chst.text}</span><span className="sp" />
              {showQ && <button className="secondary" type="button" onClick={() => { if (requireCloudflaredPath()) void tunnel('quick'); }}>启动临时</button>}
              {showN && <button className="secondary" type="button" disabled={!hasNamed} title={hasNamed ? '启动持久渠道（固定域名）' : '持久渠道需先配置固定公网地址'} onClick={() => { if (requireCloudflaredPath()) void tunnel('named'); }}>启动持久</button>}
              {showS && <button className="secondary" type="button" onClick={() => void tunnel('stop')}>停止</button>}
              {showC && <button type="button" onClick={() => void tunnel('copy')}>复制渠道地址</button>}
            </div>}
            {channelMode !== 'openai' && cnerr && <div className={'hint ' + cnerr.cls}>{cnerr.text}</div>}
            <div className="channel-install">{field('channelProxyUrl', o?.openai_tunnel?.proxy_pending_restart && <div className="hint warn" role="status">代理已保存；当前 OpenAI 进程仍使用旧配置，停止并重新启动 OpenAI 渠道后生效。</div>)}</div>
          </div>
          <div className="sec" id="set-mcp">连接器</div>
          <div className="card">
            <div className="mcpurl"><span>{selectedOpenAI ? (savedTunnelId ? 'Tunnel ID 已保存' : '尚未保存 Tunnel ID') : routes?.needs_choice ? '多个直连地址，复制时选择' : mcpValue ? (mcpLocal ? '仅本机可用' : '连接地址已生成') : '当前入口没有可用地址'}</span>
              <div className="mcp-actions">
                <button id="mcpCopy" type="button" disabled={copyBusy || !reachable || (selectedOpenAI ? !savedTunnelId : !mcpValue && !routes?.needs_choice)} onClick={() => void copyConnection()}>{copyBusy ? '处理中…' : selectedOpenAI ? '复制 Tunnel ID' : '复制 MCP 链接'}</button>
                <button id="mcpDesc" className="secondary" type="button" onClick={() => void copyDesc()}>复制连接器描述</button>
              </div>
            </div>
            <div className="connector-field">{field('connectorName')}</div>
            <div className="channel-install chrow"><span className="hint">重置会使旧 MCP 链接失效。</span><span className="sp" /><button id="mcpRotate" className="secondary danger-secondary" type="button" disabled={!reachable} onClick={() => void rotateToken()}>重置 MCP 链接</button></div>
          </div>
          <div className="sec" id="set-default-connection">默认连接</div>
          <div className="card"><div className="f">
            <label htmlFor="aiDefaultRoute">默认连接方式{fieldStatus('aiDefaultRoute')}</label>
            <select id="aiDefaultRoute" value={aiDefaultRoute} disabled={!server || fstate.aiDefaultRoute?.state === 'saving'} onChange={(e) => void commit({ aiDefaultRoute: e.target.value as SettingsValues['aiDefaultRoute'] }, ['aiDefaultRoute'])}>
              <option value="auto">自动</option><option value="direct">固定使用直连</option><option value="cloudflare">固定使用 Cloudflare</option><option value="custom">固定使用自定义公网入口</option><option value="openai">固定使用 OpenAI Tunnel</option>
            </select>
            {fieldError('aiDefaultRoute')}
            <div className="d">自动：直连开启时使用直连，否则使用上方选择的公网渠道。固定选择不会被其他入口抢占；不可用时提示，不自动换线。</div>
          </div></div>
        </>
      )}

      {page === 'network' && (
        <>
          <div className="sec" id="set-direct">直连</div>
          <DirectAccessCard on={directEnabled} port={server?.values.directPort ?? 7307} view={directView} busy={!server || directBusy || fstate.directAccessEnabled?.state === 'saving'}
            status={<>{fieldStatus('directAccessEnabled')}{fieldStatus('directPort')}</>} error={<>{fieldError('directAccessEnabled')}{fieldError('directPort')}</>}
            onToggle={(on) => void toggleDirect(on)} onPort={async (value) => { const ok = await commit({ directPort: value }, ['directPort']); if (ok) refreshHealth(); return ok; }}>
            {field('directAccessUrl')}
            <div className="address-preview">{directOrigin ? <>地址预览：<code>{directOrigin}/bh.md</code><br /><code>{directOrigin}/mcp/…</code><div className="hint">{directEnabled ? '默认连接选择直连后，复制地址使用此地址。' : '直连未开启；保存地址不会自动启用。'}</div></> : directUrl ? '地址格式无效，未用于生成连接。' : '留空使用自动发现的本机地址；多个地址在复制时选择。通用云沙箱需要它能访问的对外地址。'}</div>
          </DirectAccessCard>
          <div className="sec">检测与诊断</div>
          <div className="card">{field('tunnelProbeProxy')}</div>
        </>
      )}

      {page === 'agents' && (
        <>
      <div className="sec" id="set-proxies">MCP Proxies<small>把其他 MCP 服务器接入 BlackHole，按需启用它们的工具。</small></div>
      <Proxies ui={ui} />

      <div className="sec" id="set-common">常用<small>Skill 目录、连接器名称与语义搜索（context_search）。</small></div>
      <div className="card">
        <div className="fgrid">
          {field('skillsDir', skills && <div className={'hint ' + skills.cls}>{skills.hint}</div>)}
        </div>
        <div className="subsec">Devin Key（语义搜索）</div>
        <div className="fgrid">
          <div className="f"><label htmlFor="semKey">Devin Key</label>
            <div className="channel-probe-line">
              <input id="semKey" type="password" spellCheck={false} autoComplete="off" placeholder="sk-…" value={semKey} onChange={(e) => setSemKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void semanticSave(); }} />
              <button className="secondary" type="button" disabled={!semKey.trim()} onClick={() => void semanticSave()}>保存 Key</button>
            </div>
            <div className="chrow"><span className={'chst ' + semStatus.cls}>{semStatus.text}</span><span className="sp" />{semStatus.clear && <button className="secondary danger-secondary" type="button" onClick={() => void semanticClear()}>清除已存</button>}</div>
            <div className="d">只保存在本机；不会回显。</div>
          </div>
          <div className="f"><label>凭据来源{fieldStatus('semanticMode')}</label>
            <div className="agrid">
              {SEM_MODES.map((m) => <button key={m.v} type="button" className={'agchip' + (semMode === m.v ? ' on' : '')} aria-pressed={semMode === m.v} title={m.title} onClick={() => pickSemMode(m.v)}><span className="status-dot" aria-hidden="true" /><span className="status-label">{m.t}</span></button>)}
            </div>
            {fieldError('semanticMode')}
            <div className="d">{SEM_MODES.find((m) => m.v === semMode)?.title ?? ''}；修改后需重启 daemon。</div>
          </div>
        </div>
      </div>

      <div className="sec" id="set-courier-sites">Courier 网页站点<small>在浏览器 Courier 里用「检测此页面」接入的网页 AI，新会话可以选它们。删除后 Courier 会解除它的绑定、停止接管该网站并收回访问权限。</small></div>
      <div className="card">
        <CourierSites sites={server?.values.courierSites ?? []} status={fieldStatus('courierSites')} error={fieldError('courierSites')} onRemove={(id) => void removeCourierSite(id)} />
      </div>
        </>
      )}

      {page === 'security' && (
        <>
      <div className="sec" id="set-devices">已配对设备<small>撤销后该设备需要重新扫码。</small></div>
      <div className="card"><RemoteSection part="devices" toast={ui.toast} confirm={ui.confirm} /></div>
      <div className="sec" id="set-grants">授权管理<small>全局授权会保留；会话授权仅当前 daemon 生命周期有效。删除后相关操作会重新询问。</small></div>
      <div className="card">
        <Grants info={grants} onRemove={(s, k, id) => void grantRemove(s, k, id)} />
        <div className="btnrow" style={{ marginTop: 10 }}><button className="secondary danger-secondary" type="button" onClick={() => void grantsClear()}>清除全部全局授权</button></div>
      </div>
        </>
      )}

      {page === 'advanced' && (
        <>
      <HostRuntimeSection />
      <div className="sec" id="set-advanced">高级</div>
      <div className="card">
        <div className="fgrid">
          {field('gitUsrBinPath')}
          {!nativeHost && <div className="f"><label>daemon 端口</label><div className="bhp-readonly">{port}</div><div className="d">本地 daemon 监听端口（仅 127.0.0.1）。在 VS Code 设置中修改。</div></div>}
          {field('namedTunnelName')}
        </div>
        <div className="bhp-danger">
          <div className="bhp-danger-row">
            <div><b>重启 daemon</b><small>让需要重启的设置生效；会短暂中断本地服务和已连接的网页 AI。</small></div>
            <button className="secondary" type="button" disabled={restarting} onClick={() => void restart()}>{restarting ? '重启中…' : '重启 daemon'}</button>
          </div>
          <div className="bhp-service"><ServiceCard /></div>
        </div>
      </div>
        </>
      )}

      {nativeHost && (manualDirty.length > 0 || semanticDirty) && <div className="settings-page-save"><span className="hint">仅保存本页标有「需重启」的设置；其他页面的草稿不会提交。</span><button type="button" disabled={!server || manualPageKeys.some(k => fstate[k]?.state === 'saving')} onClick={() => void saveNativePage()}>保存本页</button></div>}
      {pending.length > 0 && (
        <div className="bhp-restartbar" role="status">
          <span>需重启 daemon 生效：{[...new Set(pending.map(restartLabel))].join('、')}</span>
          <button type="button" disabled={restarting} onClick={() => void restart()}>{restarting ? '重启中…' : '立即重启'}</button>
        </div>
      )}
      {ui.node}
    </div>
  );
}

/** One direct switch, optional advertised address, and one stable advanced port. */
function DirectAccessCard({ on, port, view, busy, status, error, onToggle, onPort, children }: {
  on: boolean; port: number; view: DirectAccessView | null; busy: boolean; status: ReactNode; error: ReactNode; children: ReactNode;
  onToggle: (on: boolean) => void; onPort: (port: number) => Promise<boolean>;
}) {
  const [portText, setPortText] = useState(String(port));
  const [portError, setPortError] = useState('');
  const [savingPort, setSavingPort] = useState(false);
  const focused = useRef(false);
  const portLock = useRef(false);
  useEffect(() => { if (!focused.current) setPortText(String(port)); }, [port]);
  const savePort = async () => {
    const n = Number(portText.trim());
    if (!portText.trim() || !Number.isInteger(n) || n < 1024 || n > 65535) { setPortError('端口必须是 1024–65535 之间的整数。'); return; }
    setPortError('');
    if (n === port || portLock.current) return;
    portLock.current = true; setSavingPort(true);
    try { await onPort(n); } finally { portLock.current = false; setSavingPort(false); }
  };
  const ready = on && view?.enabled && view.state === 'listening' && view.mode === 'direct' && view.port === port;
  const [tone, text] = busy || view?.state === 'applying' ? ['warn', '正在应用…']
    : !on ? ['', view?.mode === 'proxy' && view.listening ? '直连未开启；反向代理目标可用' : '未开启']
      : view?.error ? ['bad', view.error] : ready ? ['ok', `监听中 · 0.0.0.0:${port}`] : ['warn', '直连尚未就绪'];
  return (
    <div className="card network-entry">
      <div className="row-setting">
        <div><strong>开启直连</strong><div className="hint">局域网、组网和自己配置的公网映射，共用这一个开关。</div></div>
        <button id="directAccessToggle" type="button" role="switch" className="direct-switch" aria-label="开启直连" aria-checked={on} disabled={busy} onClick={() => onToggle(!on)} />
      </div>
      <div className={'chst ' + tone} role="status">{text}{status}</div>
      {error}
      <div className="direct-fields">{children}</div>
      <details className="connection-disclosure direct-advanced"><summary>高级<small>监听端口，通常不需要修改。</small></summary>
        <div className="f"><label htmlFor="directPort">监听端口</label>
          <input id="directPort" name="directPort" inputMode="numeric" spellCheck={false} autoComplete="off" value={portText} disabled={busy || savingPort} aria-invalid={!!portError}
            onFocus={() => { focused.current = true; }} onChange={(e) => setPortText(e.target.value)}
            onBlur={() => { focused.current = false; void savePort(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPortText(String(port)); setPortError(''); } }} />
          {portError && <div className="bhp-ferr" role="alert">{portError}</div>}
          <div className="hint">直连与反向代理共用此端口。外部映射端口可以不同；修改会短暂中断已有连接。</div>
        </div>
      </details>
      <div className="route-note"><strong>安全边界：</strong>DNS、端口映射与 TLS 由你配置。仅开放连接所需的数据接口；本地管理 API 不对外开放。</div>
    </div>
  );
}

function CourierSites({ sites, status, error, onRemove }: { sites: CourierSiteView[]; status: ReactNode; error: ReactNode; onRemove: (id: string) => void }) {
  if (!sites.length) {
    return <div className="hint" style={{ margin: 0 }}>还没有接入的网站。在浏览器里打开网页 AI 的聊天页，点工具栏 Courier 的「检测此页面」即可接入（最多 20 个）。{status}{error}</div>;
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {status && <div className="hint" style={{ margin: 0 }}>{status}</div>}
      {sites.map((x) => (
        <div className="ag-row" key={x.id}>
          <span className="nm" style={{ flex: 1 }}>
            {x.name} <span className="wa-host">{x.origin.replace(/^https:\/\//, '')}</span>
          </span>
          <button className="del" type="button" title="删除这个网站" aria-label={`删除网站 ${x.name}`} onClick={() => onRemove(x.id)}>删除</button>
        </div>
      ))}
      {error}
    </div>
  );
}

function Grants({ info, onRemove }: { info: GrantsInfo | null; onRemove: (scope: 'always' | 'session', key: string, sessionId?: string) => void }) {
  const always = info?.always ?? [];
  const sessions = (info?.sessions ?? []).filter((s) => s.grants?.length);
  if (!always.length && !sessions.length) return <div className="hint" style={{ margin: 0 }}>当前没有会跳过再次询问的授权。</div>;
  const pretty = (k: string): ReactNode => {
    if (k.startsWith('pattern:')) { const [p, lvl] = k.slice(8).split('|'); const lv = ({ critical: '不可逆', warn: '较高', info: '常规' } as Record<string, string>)[lvl ?? ''] ?? lvl; return <>{p} <span className="wa-tag">风险：{lv}</span></>; }
    if (k.startsWith('path:')) return <><span className="wa-tag">目录前缀</span> {k.slice(5)}</>;
    return k;
  };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {always.length > 0 && <div className="hint" style={{ margin: '2px 0 0' }}><b>全局授权</b> · 重启后仍保留</div>}
      {always.map((k) => <div className="ag-row" key={'a' + k}><span className="nm" style={{ flex: 1 }}>{pretty(k)}</span><button className="del" type="button" title="删除该全局授权" aria-label={`删除全局授权 ${k}`} onClick={() => onRemove('always', k)}>删除</button></div>)}
      {sessions.map((s) => (
        <div key={s.session_id} style={{ display: 'contents' }}>
          <div className="hint" style={{ margin: '4px 0 0' }}><b>会话授权</b> · {s.session_name || s.workspace_path || s.session_id || '未知会话'} · daemon 重启后失效</div>
          {s.grants.map((k) => <div className="ag-row" key={s.session_id + k}><span className="nm" style={{ flex: 1 }}>{pretty(k)}</span><button className="del" type="button" title="删除该会话授权" aria-label={`删除会话授权 ${k}`} onClick={() => onRemove('session', k, s.session_id)}>删除</button></div>)}
        </div>
      ))}
    </div>
  );
}

// ─── account and subscription ──────────────────────────────────────────────
function AccountSection({ ui, view, onView, refreshAccount, onSignOut }: {
  ui: Ui;
  view: AccountView | null;
  onView: (view: AccountView | null) => void;
  refreshAccount: () => Promise<AccountView | null>;
  onSignOut: () => void;
}) {
  const [signingIn, setSigningIn] = useState(false);
  const signIn = async () => {
    if (signingIn) return; setSigningIn(true);
    try { onView(await request<AccountView>('/host/sign-in', { method: 'POST', body: '{}' })); }
    catch (e) { ui.toast('登录未完成：' + errText(e), 'warn'); }
    finally { setSigningIn(false); }
  };
  const [plans, setPlans] = useState(DEFAULT_PLANS);
  const [sku, setSku] = useState<BillingSku>('pro_day');
  const [buyOpen, setBuyOpen] = useState(false);
  const [wait, setWait] = useState<BillingOrder | null>(null);
  const waitAbort = useRef<{ stopped: boolean } | null>(null);
  const loggedIn = !!view?.userId;
  useEffect(() => {
    if (!loggedIn) return;
    panel.plans().then((c) => {
      if (!c.enabled || !c.plans.length) return;
      setPlans(c.plans.map((p) => ({ sku: p.sku, label: planLabel(p) })));
      setSku((s) => (c.plans.some((p) => p.sku === s) ? s : c.plans[0]!.sku));
    }, () => undefined);
  }, [loggedIn]);
  const refreshView = () => panel.accountRefresh().then((next) => { onView(next); return next; }, () => undefined);
  const report = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : '';
    ui.toast('BlackHole：' + (BILLING_ERRORS[code] ?? '购买流程响应不符合预期，已停止。请从购买记录核对原订单，勿重复付款。'), 'warn');
  };
  const summary = accountSummary(view);
  const identity = !view ? '读取账号状态…'
    : summary.authState === 'logged_out' ? '尚未登录'
      : summary.email && summary.displayName !== summary.email ? `${summary.displayName} · ${summary.email}` : summary.displayName;
  const subscription = !view ? '订阅状态尚未获取'
    : summary.accountStatus === 'suspended' ? '账号已停用'
      : summary.accountStatus === 'pending' ? '订阅准备中'
        : summary.remainingSeconds === null ? '时长待确认'
          : formatRemaining(summary.remainingSeconds).replace(/^剩余 /, '剩余订阅：');

  const refresh = async () => {
    try { const next = await panel.accountRefresh(); onView(next); ui.toast('BlackHole：订阅状态已刷新。'); } catch (e) { ui.toast('BlackHole：刷新失败 — ' + errText(e), 'bad'); }
  };
  const fulfilled = async (order: BillingOrder) => {
    await refreshView();
    ui.toast(`BlackHole：支付成功，${days(order.durationSeconds)} 天订阅时长已自动叠加到当前账号。`);
  };
  /** Same schedule as VS Code: 12 checks every 5 s, then every 15 s, at most 5 minutes. */
  const waitForPayment = async (initial: BillingOrder) => {
    const token = { stopped: false };
    waitAbort.current = token;
    let current = initial;
    setWait(current);
    const deadline = Date.now() + 300000;
    try {
      for (let i = 0; i < 28 && !token.stopped && Date.now() < deadline; i++) {
        try { current = await panel.reconcile(current.id); }
        catch (e) { if (!(e instanceof ApiError) || e.code !== 'payment_result_unknown') throw e; }
        if (current.status !== 'payment_pending') break;
        await sleep(i < 12 ? 5000 : 15000);
      }
      if (token.stopped) { ui.toast(`BlackHole：已停止等待订单 ${current.id}。订单不会被取消；可稍后从购买记录查看或核对支付结果。`); return; }
      if (current.status === 'fulfilled') await fulfilled(current);
      else if (current.status === 'paid') ui.toast(`BlackHole：订单 ${current.id} 已确认付款，订阅权益正在自动入账；可稍后从购买记录继续核对。`);
      else if (current.status === 'review') ui.toast(`BlackHole：订单 ${current.id} 付款超过订单有效期，尚未发放权益。可在购买记录中选择此订单申请退款，请勿重复付款。`, 'warn');
      else ui.toast(`BlackHole：订单当前为“${STATUS_NAMES[current.status]}”。可稍后从购买记录继续核对。`);
    } catch (e) { report(e); }
    finally { if (waitAbort.current === token) { waitAbort.current = null; setWait(null); } }
  };
  const buy = async () => {
    setBuyOpen(false);
    try {
      const catalogue = await panel.plans();
      if (!catalogue.enabled) { ui.toast('支付宝时长购买尚未开放；现有订阅卡兑换不受影响。'); return; }
      const plan = catalogue.plans.find((p) => p.sku === sku);
      if (!plan) return;
      const created = await panel.createOrder(plan.sku);
      if (created.order.sku !== plan.sku || created.order.amountMinor !== plan.amountMinor || created.order.durationSeconds !== plan.durationSeconds) { ui.toast('BlackHole：订单价格或时长已变化，未打开付款页。请重新查看方案，并在购买记录核对该待支付订单。', 'warn'); return; }
      if (!created.opened) { ui.toast('未能打开系统浏览器。订单已经保留，请从购买记录继续付款。', 'warn'); return; }
      await waitForPayment(created.order);
    } catch (e) { report(e); }
  };
  const refund = async (selected?: BillingOrder) => {
    try {
      let order = selected;
      let cursor: string | undefined;
      while (!order) {
        const page = await panel.refundable(cursor);
        if (!page.orders.length && !cursor) { ui.toast('当前账号没有可退款的订单。'); return; }
        const items: PickItem[] = page.orders.map((o) => ({ label: orderLabel(o), description: o.id, value: o.id }));
        if (page.nextCursor) items.push({ label: '加载更多…', value: '__more' });
        const v = await ui.pick('选择要退款的订单', items);
        if (!v) return;
        if (v === '__more') { cursor = page.nextCursor ?? undefined; continue; }
        order = page.orders.find((o) => o.id === v);
      }
      const quote = await panel.refundQuote(order.id);
      const ok = await ui.confirm(`申请退款 ${price(quote.amountMinor)}？`, ['确认退款'],
        <div className="buy-summary"><span className="k">订单</span><span className="v">{order.id}</span><span className="k">未使用时长</span><span className="v">{durationLabel(quote.unusedSeconds)}</span><span className="k">退款金额</span><span className="v">{price(quote.amountMinor)}</span></div>);
      if (ok !== '确认退款') return;
      const r = await panel.refund(order.id, quote.quoteToken);
      const failed = r.status === 'failed' || r.status === 'provider_failed';
      ui.toast(r.status === 'refunded' || r.status === 'provider_succeeded' ? `BlackHole：退款 ${price(r.amountMinor)} 已完成，将原路退回。` : r.status === 'requested' ? 'BlackHole：退款已提交，处理完成后原路退回。' : 'BlackHole：退款未成功，请稍后从设置页再次选择同一订单核对。', failed ? 'warn' : 'info');
      await refreshView();
    } catch (e) { report(e); }
  };
  const orders = async () => {
    try {
      const rows = await panel.orders();
      if (!rows.length) { ui.toast('当前账号还没有支付宝购买订单。'); return; }
      const now = Math.floor(Date.now() / 1000);
      const visible = rows.map((o) => (o.status === 'payment_pending' && o.expiresAt <= now ? { ...o, status: 'expired' as const } : o));
      const id = await ui.pick('最近 20 笔时长购买订单', visible.map((o) => ({ label: orderLabel(o), description: o.id, value: o.id })));
      const order = visible.find((o) => o.id === id);
      if (!order) return;
      const actions: string[] = [];
      if (order.status === 'payment_pending') actions.push('继续付款', '核对支付结果');
      if (order.status === 'paid') actions.push('核对自动到账');
      if (order.status === 'expired') actions.push('核对支付结果');
      if (order.status === 'review') actions.push('申请退款');
      if (!actions.length) { ui.toast(`订单 ${order.id}：${STATUS_NAMES[order.status]}。如需退款，请使用设置页的“申请退款”；异常核对时请保留此订单 ID。`); return; }
      const action = await ui.pick(`订单 ${order.id}`, actions.map((x) => ({ label: x, value: x })));
      if (!action) return;
      if (action === '申请退款') { await refund(order); return; }
      if (action === '继续付款') {
        const c = await panel.checkout(order.id);
        if (!c.opened) { ui.toast('未能打开系统浏览器。订单仍然保留。', 'warn'); return; }
        await waitForPayment(c.order);
        return;
      }
      const updated = await panel.reconcile(order.id);
      if (updated.status === 'fulfilled') await fulfilled(updated);
      else ui.toast(`BlackHole：订单 ${updated.id} 当前为“${STATUS_NAMES[updated.status]}”。`);
    } catch (e) { report(e); }
  };
  const redeem = async () => {
    const code = await ui.input('兑换订阅卡', '兑换', '输入订阅卡卡密');
    if (!code) return;
    try {
      const r = await panel.redeem(code);
      ui.toast(r.duplicate ? 'BlackHole：这张订阅卡已兑换过，订阅未重复增加。' : 'BlackHole：订阅卡已兑换，订阅时长已更新。');
      await refreshView();
    } catch (e) { ui.toast('BlackHole：兑换失败 — ' + errText(e), 'bad'); }
  };
  const planText = plans.find((p) => p.sku === sku)?.label ?? '所选方案';
  return (
    <section className="card account-card" aria-label="账号与订阅">
      <div className="account-head"><div><div className="account-eyebrow">BLACKHOLE ACCOUNT</div><div className="account-identity">{identity}</div></div></div>
      <div className="account-grid">
        <div><span className="account-label">服务权益</span><div id="cloudSubscription">{subscription}</div></div>
        <div><label className="account-label" htmlFor="cloudPlan">订阅方案</label>
          <div className="plan-line">
            <select id="cloudPlan" disabled={!loggedIn} value={sku} onChange={(e) => setSku(e.target.value as BillingSku)}>{plans.map((p) => <option key={p.sku} value={p.sku}>{p.label}</option>)}</select>
            <button id="cloudBuyCard" className="secondary" type="button" disabled={!loggedIn || !!wait} onClick={() => setBuyOpen(true)}>购买所选方案</button>
          </div>
        </div>
      </div>
      <div className="btnrow">
        {settingsHost().kind === 'vscode' && !loggedIn && <button type="button" disabled={signingIn} onClick={() => void signIn()}>{signingIn ? '登录中…' : '登录'}</button>}
        {summary.canSignOut && <button className="secondary" type="button" onClick={onSignOut}>退出登录</button>}
        {view?.userId && <button className="secondary" type="button" onClick={() => void copy(view.userId!).then(ok => ui.toast(ok ? 'BlackHole：用户 ID 已复制。' : '复制失败，请重试。', ok ? 'info' : 'warn'))}>复制用户 ID</button>}
        <button className="secondary" type="button" disabled={!loggedIn} onClick={() => void refresh()}>刷新订阅</button>
        <button className="secondary" type="button" disabled={!loggedIn} onClick={() => void orders()}>购买记录</button>
        <button className="secondary" type="button" disabled={!loggedIn} onClick={() => void refund()}>申请退款</button>
        <button className="secondary" type="button" disabled={!loggedIn} onClick={() => void redeem()}>兑换订阅卡</button>
      </div>
      {wait && <div className="bhp-wait" role="status"><span>正在确认支付宝付款… 订单 {wait.id}</span><button className="secondary" type="button" onClick={() => { if (waitAbort.current) waitAbort.current.stopped = true; }}>停止等待</button></div>}
      <div className="account-note">服务权益以最近一次服务端校验结果为准。</div>
      {buyOpen && (
        <div className="buy-modal" role="dialog" aria-modal="true" aria-labelledby="cloudBuyTitle" onClick={(e) => { if (e.target === e.currentTarget) setBuyOpen(false); }} onKeyDown={(e) => { if (e.key === 'Escape') setBuyOpen(false); }}>
          <div className="buy-dialog">
            <div className="buy-dialog-head"><div className="buy-dialog-eyebrow">BLACKHOLE · 单次订阅购买</div><div className="buy-dialog-title" id="cloudBuyTitle">确认购买方案</div></div>
            <div className="buy-dialog-body"><div className="buy-summary"><span className="k">订阅方案</span><span className="v">{planText}</span><span className="k">购买账号</span><span className="v">{view?.userId ? view.userId.slice(0, 8) + '…' + view.userId.slice(-4) : '—'}</span><span className="k">到账方式</span><span className="v">支付确认后自动叠加</span></div><div className="buy-dialog-note">下一步将在系统浏览器打开 BlackHole 支付确认页，再进入支付宝收银台。每次购买均为单次付款，不会自动续费；无需领取卡密或联系管理员开通。</div></div>
            <div className="buy-dialog-actions"><button className="secondary" type="button" onClick={() => setBuyOpen(false)}>取消</button><button type="button" autoFocus onClick={() => void buy()}>前往付款</button></div>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── MCP proxies ───────────────────────────────────────────────────────────
const PX_BADGE: Record<string, [string, string]> = { online: ['ok', '在线'], starting: ['warn', '启动中…'], offline: ['warn', '等待启动'], degraded: ['warn', '工具异常'], crashed: ['bad', '启动失败'], config_error: ['bad', '配置错误'], disabled: ['dim', '已停用'] };
const splitLines = (s: string) => s.split('\n').map((x) => x.replace('\r', '').trim()).filter(Boolean);
type ToolsState = { ok: boolean; result?: ProxyToolsResult; detail?: string; loading?: boolean };
type Msg = { cls: string; text: string } | null;

function Proxies({ ui }: { ui: Ui }) {
  const [info, setInfo] = useState<ProxiesInfo | null | undefined>(undefined);
  const [tools, setTools] = useState<Record<string, ToolsState>>({});
  const [modal, setModal] = useState<string | null>(null);
  const [modalStatus, setModalStatus] = useState<Msg>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const switchFocus = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (pending.size) return;
    const target = switchFocus.current;
    switchFocus.current = null;
    // Native disabled buttons lose keyboard focus while saving. Restore only
    // when it fell back to the body, never after the user chose another control.
    if (target?.isConnected && !target.disabled && document.activeElement === document.body) target.focus({ preventScroll: true });
  }, [pending]);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<'add' | 'import' | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [report, setReport] = useState<RevalidateReport | null>(null);
  const load = useCallback(() => panel.proxies().then(setInfo, () => setInfo(null)), []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 3000); return () => clearInterval(t); }, [load]);

  const cfg: Record<string, ProxyConfigRow> = {};
  for (const c of info?.config ?? []) cfg[c.name] = c;
  const disabled = new Set(info?.disabled ?? []);
  const rows = info?.status ?? [];

  const fetchTools = async (name: string) => {
    setTools((t) => ({ ...t, [name]: { ...(t[name] ?? { ok: true }), loading: true } }));
    try { const result = await panel.proxiesTools(name, true); setTools((t) => ({ ...t, [name]: { ok: true, result } })); }
    catch (e) { setTools((t) => ({ ...t, [name]: { ok: false, detail: errText(e) } })); }
  };
  const openModal = (name: string) => { setModal(name); setModalStatus(null); if (!tools[name]?.result) void fetchTools(name); };
  const saveFields = async (name: string, fields: Record<string, unknown>) => {
    if (pending.has(name)) return false;
    setPending((p) => new Set(p).add(name));
    if (modal === name) setModalStatus({ cls: 'pxkv', text: '保存中…' });
    try {
      const r = await panel.proxiesEdit(name, fields);
      if (!r.written) throw new Error('写入被拒绝');
      setMsg({ cls: 'ok', text: '已保存' });
      if (modal === name) setModalStatus({ cls: 'pxkv', text: '已保存' });
      await load();
      return true;
    } catch (e) {
      setMsg({ cls: 'err', text: '保存失败：' + errText(e) });
      if (modal === name) setModalStatus({ cls: 'pxkv bad', text: '保存失败：' + errText(e) });
      return false;
    } finally { setPending((p) => { const n = new Set(p); n.delete(name); return n; }); }
  };
  const remove = async (name: string) => {
    if ((await ui.confirm(`BlackHole: 将「${name}」从 mcp-proxies.yaml 中删除？不可撤销。`, ['删除'])) !== '删除') return;
    try { const r = await panel.proxiesRemove(name); if (!r.removed) throw new Error('删除被拒绝'); await load(); }
    catch (e) { setMsg({ cls: 'err', text: '删除失败：' + errText(e) }); }
  };
  const revalidate = async () => {
    try { setReport(await panel.proxiesRevalidate()); } catch { ui.toast('BlackHole: 重新校验失败 — daemon 不可达', 'bad'); }
  };

  const fmtTarget = (c: ProxyConfigRow) => (c.transport === 'http' ? c.url || '' : [c.command || '', ...(c.args || [])].filter((x) => x !== '').join(' '));
  const body = info === undefined ? <div className="hint" style={{ margin: 0 }}>读取中…</div>
    : !info ? <div className="hint" style={{ margin: 0 }}>本地服务未连接</div>
    : !info.configured || !rows.length ? <div className="hint" style={{ margin: 0 }}>暂无 MCP server</div>
    : rows.map((s) => {
      const c: ProxyConfigRow = cfg[s.name] ?? { name: s.name };
      const exposedN = s.catalogCount === null ? -1 : typeof s.catalogCount === 'number' ? s.catalogCount : (s.tools || []).length || -1;
      const isOff = disabled.has(s.name) || s.status === 'disabled';
      const d = tools[s.name];
      const count = d?.ok && d.result ? (d.result.tools || []).filter((x) => x.enabled !== false).length : exposedN;
      const canManage = !isOff && (s.status === 'online' || s.status === 'degraded') && exposedN >= 0;
      const badge = PX_BADGE[s.status] ?? ['dim', s.status || '未知'];
      const tgt = fmtTarget(c);
      return (
        <div className="pxs" key={s.name}>
          <div className="hd">
            <span className="nm" title={s.name}>{s.name}</span>
            <span className={'pxb ' + badge[0]}><span className="status-dot" aria-hidden="true" /><span className="status-label">{badge[1]}</span></span>
            {canManage && <button type="button" className={'pchip ' + (count < 0 ? 'cold' : 'filesonly')} data-tools={s.name} aria-haspopup="dialog" aria-label={`管理 ${s.name} 的工具`} onClick={() => openModal(s.name)}>{count < 0 ? '未加载' : count + ' 个工具'}</button>}
            <span className="pxbtns">
              {s.status !== 'config_error' && <button type="button" className={'pxsw' + (isOff ? '' : ' on')} role="switch" aria-label={'启用 ' + s.name} aria-checked={!isOff} title={isOff ? '启用并启动 MCP' : '停用并断开 MCP'} disabled={pending.has(s.name)} onClick={(e) => { switchFocus.current = document.activeElement === e.currentTarget ? e.currentTarget : null; void saveFields(s.name, { enabled: isOff }); }} />}
              {s.status !== 'config_error' && <button type="button" className="pxe" aria-label={`编辑 MCP ${s.name}`} onClick={() => setEditing((e) => (e === s.name ? null : s.name))}>编辑</button>}
              <button type="button" className="pxe danger" aria-label={`删除 MCP ${s.name}`} onClick={() => void remove(s.name)}>删除</button>
            </span>
          </div>
          {s.status === 'config_error' && s.reason && <div className="pxkv bad">校验失败：{s.reason}</div>}
          {s.status === 'crashed' && s.reason && <div className="pxkv bad">崩溃原因：{s.reason}</div>}
          {s.status === 'degraded' && (s.missingTools || []).length > 0 && <div className="pxkv warn">缺失工具：{(s.missingTools || []).join('、')}</div>}
          {(c.warnings || []).map((w) => <div className="pxkv warn" key={w}>警告：{w}</div>)}
          {tgt && <div className="pxtarget">{(c.transport || 'stdio') + ' · ' + tgt}</div>}
          {editing === s.name && <ProxyEdit c={c} onCancel={() => setEditing(null)} onSave={async (fields) => { if (await saveFields(s.name, fields)) setEditing(null); }} />}
        </div>
      );
    });

  return (
    <div className="card">
      <div>{body}</div>
      <div className="btnrow" style={{ marginTop: 10 }}>
        <button className="secondary" type="button" disabled={!info} onClick={() => setForm((f) => (f === 'add' ? null : 'add'))}>添加 MCP</button>
        <button className="secondary" type="button" disabled={!info} onClick={() => setForm((f) => (f === 'import' ? null : 'import'))}>导入 JSON</button>
        <button className="secondary" type="button" disabled={!info} onClick={() => void revalidate()}>重新校验</button>
      </div>
      {form === 'add' && <ProxyAdd onDone={(warning) => { setForm(null); setMsg(warning ? { cls: 'warn', text: '已添加（' + warning + '）' } : { cls: 'ok', text: '✓ 已添加' }); void load(); }} />}
      {form === 'import' && <ProxyImport onDone={(detail) => { setForm(null); setMsg({ cls: 'ok', text: '✓ 导入完成：' + detail }); void load(); }} />}
      <div className={'pxkv ' + (msg?.cls ?? '')} id="pxMsg">{msg?.text}</div>
      {report && (
        <div>
          <div className="pxkv">重新校验 · <b>{(report.servers || []).filter((x) => x.ok).length}/{(report.servers || []).length}</b> 个 server 配置有效</div>
          {(report.quarantined || []).map((q) => <div className="pxkv bad" key={'q' + q.name}>已隔离：{q.name} — {q.reason}</div>)}
          {(report.warnings || []).map((w, i) => <div className="pxkv warn" key={'w' + i}>警告：{w.name} — {w.reason}</div>)}
        </div>
      )}
      {modal && (
        <div className="pxmodal" onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }} onKeyDown={(e) => { if (e.key === 'Escape') setModal(null); }}>
          <div className="pxmbox" role="dialog" aria-modal="true" aria-label={modal}>
            <div className="pxmhd"><span className="pxmt">{modal}</span><span className="sp" /><button type="button" className="pxe" autoFocus onClick={() => setModal(null)}>关闭</button></div>
            <div className={modalStatus?.cls ?? 'pxkv'} role="status" aria-live="polite">{modalStatus?.text}</div>
            <div className="pxmbody">
              <ToolList name={modal} data={tools[modal]} cfg={cfg[modal]} busy={pending.has(modal)} onRefresh={() => void fetchTools(modal)}
                onToggle={(tool, on) => {
                  const catalog = tools[modal]?.result?.tools ?? [];
                  const current = cfg[modal]?.surface?.expose;
                  const selected = new Set(Array.isArray(current) ? current : catalog.map((x) => x.upstreamTool || x.name));
                  if (on) selected.add(tool); else selected.delete(tool);
                  void saveFields(modal, { surface: { ...(cfg[modal]?.surface || {}), expose: [...selected] } });
                }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolList({ name, data, cfg, busy, onRefresh, onToggle }: { name: string; data?: ToolsState; cfg?: ProxyConfigRow; busy: boolean; onRefresh: () => void; onToggle: (tool: string, on: boolean) => void }) {
  if (!data || (data.loading && !data.result)) return <div className="pxthr"><span className="pxth">拉取中…</span></div>;
  if (!data.ok) return <div className="pxkv bad">拉取失败：{data.detail}</div>;
  const r: ProxyToolsResult = data.result ?? {};
  const list = r.tools || [];
  const dupN = list.filter((x) => (x.conflictSources || []).length > 1).length;
  const expose = cfg?.surface?.expose;
  return (
    <>
      <div className="pxthr"><span className="pxth">{'工具 ' + list.length + (dupN > 0 ? ' · 重名 ' + dupN : '') + (r.cachedOnly ? ' · 缓存' : ' · 实时') + (r.ageMs != null ? ' · ' + Math.round(r.ageMs / 1000) + 's 前' : '')}</span><span className="sp" /><button type="button" className="pxe" disabled={!!r.disabled || data.loading} onClick={onRefresh}>刷新</button></div>
      {r.disabled && <div className="pxkv dim">已停用</div>}
      {r.error && <div className="pxkv bad">{r.error}</div>}
      {!list.length ? <div className="pxkv dim">{r.disabled ? '无缓存' : '无工具'}</div> : (
        <div className="pxrows">
          {list.map((t) => {
            const canonical = t.upstreamTool || t.name;
            const enabled = !Array.isArray(expose) || expose.includes(canonical);
            const conflicts = t.conflictSources || [];
            return (
              <div className={'pxrow' + (enabled ? '' : ' muted')} key={name + canonical}>
                <div className="pxrn">
                  <label className="pxtool-toggle"><input name="px-tool-enabled" type="checkbox" checked={enabled} disabled={busy} onChange={(e) => onToggle(canonical, e.target.checked)} /><span>{t.name}</span></label>
                  {conflicts.length > 1 && <span className="pchip dup">名称冲突 · {conflicts.join(', ')}</span>}
                  {!enabled && <span className="pchip">已屏蔽</span>}
                  {t.upstreamTool && t.upstreamTool !== t.name && <span className="pchip">upstream: {t.upstreamTool}</span>}
                </div>
                {t.description && <div className="pxrd">{t.description}</div>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function ProxyEdit({ c, onSave, onCancel }: { c: ProxyConfigRow; onSave: (fields: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [transport, setTransport] = useState(c.transport === 'http' ? 'http' : 'stdio');
  const [command, setCommand] = useState(c.command || '');
  const [args, setArgs] = useState((c.args || []).join('\n'));
  const [url, setUrl] = useState(c.url || '');
  const [advanced, setAdvanced] = useState(() => {
    const out: Record<string, unknown> = {};
    for (const k of ADVANCED_EDIT_KEYS) {
      const v = c[k];
      if (v === undefined || v === null || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length)) continue;
      out[k] = v;
    }
    return JSON.stringify(out, null, 2);
  });
  const [msg, setMsg] = useState<Msg>(null);
  const save = () => {
    const fail = (text: string) => setMsg({ cls: 'form-msg err', text });
    const fields: Record<string, unknown> = { transport };
    if (transport === 'stdio') { if (!command.trim()) return fail('stdio 需要 Command'); fields.command = command.trim(); fields.args = splitLines(args); fields.url = null; }
    else { if (!url.trim()) return fail('http 需要 URL'); fields.url = url.trim(); fields.command = null; fields.args = []; }
    let adv: unknown;
    try { adv = JSON.parse(advanced || '{}'); } catch { return fail('高级设置 JSON 解析失败'); }
    if (adv === null || typeof adv !== 'object' || Array.isArray(adv)) return fail('高级设置必须是 JSON 对象');
    const bad = Object.keys(adv).filter((k) => !ADVANCED_EDIT_KEYS.includes(k));
    if (bad.length) return fail('不可编辑：' + bad.join(', '));
    Object.assign(fields, adv);
    setMsg({ cls: 'form-msg busy', text: '保存中…' });
    void onSave(fields).then(() => setMsg(null));
  };
  return (
    <div className="pxedit">
      <div className="fgrid pxeditgrid">
        <div className="f"><label>Transport</label><select name="px-transport" aria-label="Transport" value={transport} onChange={(e) => setTransport(e.target.value)}><option value="stdio">stdio</option><option value="http">http</option></select></div>
        {transport === 'stdio' && <div className="f"><label>Command</label><input name="px-command" aria-label="Command" spellCheck={false} value={command} onChange={(e) => setCommand(e.target.value)} /></div>}
        {transport === 'stdio' && <div className="f fwide"><label>Arguments <span className="hint">每行一个参数</span></label><textarea name="px-args" aria-label="Args" spellCheck={false} rows={4} value={args} onChange={(e) => setArgs(e.target.value)} /></div>}
        {transport === 'http' && <div className="f fwide"><label>URL</label><input name="px-url" aria-label="URL" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} /></div>}
      </div>
      <details className="pxadv"><summary>高级代理设置</summary><textarea name="px-advanced" aria-label="高级代理设置" className="pxjson" spellCheck={false} rows={7} value={advanced} onChange={(e) => setAdvanced(e.target.value)} /></details>
      <div className="btnrow"><button type="button" className="pxe" onClick={save}>保存</button><button type="button" className="pxe secondary" onClick={onCancel}>取消</button>{msg && <span className={msg.cls}>{msg.text}</span>}</div>
    </div>
  );
}

function ProxyAdd({ onDone }: { onDone: (warning: string | null) => void }) {
  const [v, setV] = useState({ name: '', transport: 'stdio', command: '', url: '', args: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const go = async () => {
    const fail = (text: string) => setMsg({ cls: 'form-msg err', text });
    const name = v.name.trim();
    if (!name) return fail('名称必填');
    const server: Record<string, unknown> = { name, enabled: true, transport: v.transport };
    if (v.transport === 'stdio') { if (!v.command.trim()) return fail('stdio 需要 command'); server.command = v.command.trim(); if (v.args.trim()) server.args = splitLines(v.args); }
    else { if (!v.url.trim()) return fail('http 需要 url'); server.url = v.url.trim(); }
    setBusy(true); setMsg(null);
    try { const r = await panel.proxiesAdd(server); if (!r.added) throw new Error('校验未通过'); onDone(typeof r.warning === 'string' && r.warning ? r.warning : null); }
    catch (e) { setBusy(false); fail('添加失败：' + errText(e)); }
  };
  const up = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  return (
    <div onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') void go(); }}>
      <div className="fgrid" style={{ marginTop: 10 }}>
        <div className="f"><label>名称</label><input name="pxa-name" aria-label="名称" spellCheck={false} placeholder="如 chrome" value={v.name} onChange={up('name')} /></div>
        <div className="f"><label>transport</label><select name="pxa-transport" aria-label="Transport" value={v.transport} onChange={up('transport')}><option value="stdio">stdio</option><option value="http">http</option></select></div>
        {v.transport === 'stdio' && <div className="f"><label>command</label><input name="pxa-command" aria-label="Command" spellCheck={false} placeholder="如 node / npx" value={v.command} onChange={up('command')} /></div>}
        {v.transport === 'http' && <div className="f"><label>url</label><input name="pxa-url" aria-label="URL" spellCheck={false} placeholder="http://127.0.0.1:9000/mcp" value={v.url} onChange={up('url')} /></div>}
        {v.transport === 'stdio' && <div className="f fwide"><label>Arguments <span className="hint">每行一个参数</span></label><textarea name="pxa-args" aria-label="Args" spellCheck={false} rows={3} placeholder={'-y\nsome-mcp@1.9.0'} value={v.args} onChange={up('args')} /></div>}
      </div>
      <div className="btnrow" style={{ marginTop: 10 }}><button type="button" disabled={busy} onClick={() => void go()}>{busy ? '添加中…' : '添加'}</button>{msg && <span className={msg.cls}>{msg.text}</span>}</div>
    </div>
  );
}

function ProxyImport({ onDone }: { onDone: (detail: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const go = async () => {
    if (!text.trim()) { setMsg({ cls: 'form-msg err', text: '粘贴 JSON 后再导入' }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await panel.proxiesImport(text);
      const failed = (r.failed ?? []).map((f) => `${f.name}: ${f.error}`).join('；');
      if (!r.imported?.length) throw new Error(failed || '没有可导入的条目');
      onDone(`已导入 ${r.imported.join('、')}${failed ? '；失败：' + failed : ''}`);
    } catch (e) { setBusy(false); setMsg({ cls: 'form-msg err', text: '导入失败：' + errText(e) }); }
  };
  return (
    <>
      <div className="f" style={{ marginTop: 10 }}><label>粘贴 mcpServers JSON</label><textarea name="px-import" aria-label="MCP JSON" rows={6} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void go(); }} /></div>
      <div className="btnrow" style={{ marginTop: 10 }}><button type="button" disabled={busy} onClick={() => void go()}>{busy ? '导入中…' : '导入'}</button>{msg && <span className={msg.cls}>{msg.text}</span>}</div>
    </>
  );
}
