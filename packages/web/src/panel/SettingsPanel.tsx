// Web / app settings panel: a copy of the VS Code settings panel (packages/vscode/src/configPanel.ts)
// — same sections, order, class names and copy — backed by the daemon (plan 6.12 S5).
// VS Code's native notifications, modal dialogs and quick picks become in-page equivalents.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api, ApiError, panel,
  type AccountView, type BillingOrder, type BillingPlan, type BillingSku, type GrantsInfo, type Health,
  type ProxiesInfo, type ProxyConfigRow, type ProxyToolsResult, type RevalidateReport, type SemanticInfo, type SettingsValues, type SettingsView,
} from '../api';
import './panel.css';
import { RemoteSection } from './RemoteSection';

type TextKey = 'cloudflaredPath' | 'publicBaseUrl' | 'tunnelProbeProxy' | 'gitUsrBinPath' | 'skillsDir' | 'connectorName' | 'namedTunnelName';
const FIELD: Record<TextKey, { label: string; desc: string }> = {
  cloudflaredPath: { label: 'cloudflared 路径', desc: '公网渠道需要 cloudflared。安装后填写可执行文件的完整路径。' },
  publicBaseUrl: { label: '公网地址', desc: '填写 HTTPS Base URL；BlackHole 会自动生成 MCP 链接。' },
  tunnelProbeProxy: { label: '公网连通性检测代理（排障用）', desc: '通常留空。仅当提示“公网地址已在线，但本机无法完成检测”，并且电脑正在使用 Clash、mihomo 等本机代理时，填写该代理的本机 HTTP 地址（例如 http://127.0.0.1:7897）。这里只影响公网地址检测，不会修改其他网络连接；修改后需重启本地服务。' },
  gitUsrBinPath: { label: 'GNU 工具目录 (Git usr/bin)', desc: 'grep/sed/awk/find 所在目录（Git for Windows 安装目录下的 usr/bin）。会加入 BlackHole exec/process 的 PATH，但不会把 shell 切换为 Bash；留空则不改 PATH。' },
  skillsDir: { label: '自定义 Skill 目录', desc: '留空使用 ~/.agents/skills。填写后替代这个默认库；项目里的 .agents/skills 仍然有效且优先。建议填绝对路径或 ~/ 开头的路径。' },
  connectorName: { label: '连接器名称', desc: '复制连接器提示词时 @提及的名字。多人共用一个网页 AI 账号时，各自起名区分自己的连接器。留空 = BlackHole。' },
  namedTunnelName: { label: 'named tunnel 名称', desc: '持久渠道执行的 cloudflared tunnel run <名称>。' },
};
const TEXT_KEYS = Object.keys(FIELD) as TextKey[];
/** Same catalogue as packages/vscode/src/webAgents.ts AGENTS. */
const AGENTS = [
  { name: 'ChatGPT', description: 'OpenAI ChatGPT' },
  { name: 'WorkBuddy', description: 'WorkBuddy 工作助手' },
  { name: 'Manus', description: 'Manus AI agent' },
  { name: 'Trae CN', description: 'Trae (国内版)' },
  { name: 'Trae AI', description: 'Trae (国际版)' },
  { name: 'Arena', description: 'LMArena AI' },
];
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
function normalizeUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u.toString() : null;
  } catch { return null; }
}
async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
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
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  return (
    <div className="buy-modal" role="dialog" aria-modal="true" aria-labelledby="bhpDialogTitle" onClick={(e) => { if (e.target === e.currentTarget) close(null); }}>
      <div className="buy-dialog">
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
      </div>
    </div>
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
      <div className="activity-head"><div className="ck-k">活动</div><div className="activity-today">{today}</div></div>
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
const draftOf = (v: SettingsValues): Draft => Object.fromEntries(TEXT_KEYS.map((k) => [k, String((v as unknown as Record<string, unknown>)[k] ?? '')])) as Draft;
const serverText = (v: SettingsValues, k: TextKey) => String((v as unknown as Record<string, unknown>)[k] ?? '');

export function SettingsPanel() {
  const ui = useUi();
  const [server, setServer] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [channelMode, setChannelMode] = useState<'cloudflare' | 'openai' | 'custom'>('cloudflare');
  const [semMode, setSemMode] = useState<string>('explicit');
  const [semKey, setSemKey] = useState('');
  const [agentsOn, setAgentsOn] = useState<Set<string>>(new Set());
  const [health, setHealth] = useState<Health | null>(null);
  const [reachable, setReachable] = useState(true);
  const [semantic, setSemantic] = useState<SemanticInfo | null | undefined>(undefined);
  const [skills, setSkills] = useState<{ cls: string; hint: string } | null>(null);
  const [customProbe, setCustomProbe] = useState<{ url: string; state: 'idle' | 'probing' | 'online' | 'error'; detail: string }>({ url: '', state: 'idle', detail: '' });
  const [cf, setCf] = useState<{ busy: boolean; label: string; cls: string; text: string }>({ busy: false, label: '一键初始化安装', cls: 'hint', text: '准备并验证 cloudflared；验证后可选择保存并重启 daemon，不会自动启动渠道。' });
  const [waName, setWaName] = useState('');
  const [waUrl, setWaUrl] = useState('');
  const [grants, setGrants] = useState<GrantsInfo | null>(null);
  const [saving, setSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    const s = await api.settings();
    setServer(s);
    setDraft(draftOf(s.values));
    setChannelMode(s.values.channelMode);
    setSemMode(s.values.semanticMode);
    setAgentsOn(new Set(s.values.webAgents));
    setSemKey('');
    setCustomProbe({ url: '', state: 'idle', detail: '' });
    return s;
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
        try { setHealth(await panel.health()); setReachable(true); } catch { setReachable(false); }
        await sleep(2000);
      }
    })();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skillsDir = draft?.skillsDir;
  useEffect(() => {
    if (skillsDir === undefined) return;
    const t = setTimeout(() => { panel.skills(skillsDir.trim()).then(setSkills, () => setSkills(null)); }, 300);
    return () => clearTimeout(t);
  }, [skillsDir]);

  const set = (k: TextKey, v: string) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  // ── status (renderStatus) ──
  const o = health;
  const t = reachable ? o?.tunnel : 'unreachable';
  const dm: [string, string] = reachable ? ['ok', '运行中' + (o?.version ? ' · v' + o.version : '')] : ['', '未运行'];
  const cmap: Record<string, [string, string]> = { online: ['ok', o?.tunnel_mode === 'named' ? '持久在线' : '临时在线'], unverified: ['warn', '未验证'], starting: ['warn', '启动中…'], error: ['bad', '启动失败'], unavailable: ['bad', '不可用'], unreachable: ['', '未连接'] };
  const customMap: Record<string, [string, string]> = { idle: ['', '待检测'], probing: ['warn', '检测中…'], online: ['ok', '自定义在线'], error: ['bad', '自定义不可达'] };
  const cm: [string, string] = channelMode === 'custom' ? customMap[customProbe.state] ?? ['', '待检测'] : cmap[t ?? ''] ?? ['', '未启动'];
  const hasNamed = !!o?.public_base_url;
  let chst: { text: string; cls: string };
  let cnerr: { text: string; cls: string } | null = null;
  let showQ = true, showN = true, showS = false, showC = false;
  if (channelMode === 'custom') {
    showQ = showN = false;
    const s = customProbe.state === 'online' ? ['自定义 · 在线', 'ok'] : customProbe.state === 'probing' ? ['检测中…', 'warn'] : customProbe.state === 'error' ? ['自定义 · 不可达', 'bad'] : ['待检测', 'dim'];
    chst = { text: s[0]!, cls: s[1]! };
    if (customProbe.detail) cnerr = { text: customProbe.detail, cls: customProbe.state === 'error' ? 'bad' : '' };
  } else if (channelMode === 'openai') {
    // The OpenAI channel is managed from the VS Code settings page (plan D5).
    showQ = showN = false;
    chst = { text: '在 VS Code 中管理', cls: 'dim' };
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
  const mcpValue = channelMode === 'custom' ? (customReady && o?.mcp_path ? customProbe.url + o.mcp_path : '') : reachable ? o?.mcp_url || '' : '';

  // ── actions ──
  const refreshHealth = () => { panel.health().then(setHealth, () => undefined); };
  const requireCloudflaredPath = () => {
    if (draft?.cloudflaredPath.trim()) return true;
    ui.toast('使用公网渠道前，请先填写 cloudflared 可执行文件的完整路径并保存。', 'warn');
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
      const choice = await ui.confirm('BlackHole：cloudflared 验证通过。保存该路径并重启 daemon 使其生效？', ['仅回填路径', '保存并重启'],
        <div className="buy-dialog-note" style={{ marginTop: 0 }}>{job.path}<br />重启会短暂中断本地服务；不会自动启动公网渠道。</div>);
      if (choice === '保存并重启') {
        const latest = await api.settings();
        if (latest.values.channelMode !== initialMode || latest.values.cloudflaredPath !== initialPath) { done('hint bad', `渠道配置已变化，未保存路径或重启 daemon。已验证文件：${job.path}`); return; }
        setCf({ busy: true, label: '正在应用…', cls: 'hint', text: '正在保存路径并重启 daemon；不会自动启动渠道。' });
        setServer(await api.saveSettings(latest.revision, { cloudflaredPath: job.path }));
        set('cloudflaredPath', job.path);
        const restarted = await restartAndWait();
        done(restarted ? 'hint ok' : 'hint bad', restarted ? '路径已保存，daemon 已重启；尚未启动渠道。' : '路径已保存，但 daemon 重启失败。');
        return;
      }
      if ((document.getElementById('cloudflaredPath') as HTMLInputElement | null)?.value !== previous) {
        done('hint', 'cloudflared 已就绪：' + job.path + '。当前模式或路径已变化，未自动回填；请自行确认。');
        return;
      }
      set('cloudflaredPath', job.path);
      done('hint ok', (job.installed ? '安装完成。' : '已有可用的 cloudflared，未下载。') + '路径已回填，请按原流程保存设置；尚未启动渠道。');
    } catch (e) { done('hint bad', errText(e)); }
  };
  const restart = async () => {
    if (await restartAndWait()) { ui.toast('BlackHole：daemon 已重启。'); await loadSettings().catch(() => undefined); loadSemantic(); }
    else ui.toast('BlackHole：重启 daemon 失败', 'bad');
  };
  const rotateToken = async () => {
    if ((await ui.confirm('BlackHole: 重置后旧 MCP 链接立即失效，连接器/沙箱脚本里配置的旧地址全部要换成新链接（会话 ID 不受影响）。确认重置？', ['重置'])) !== '重置') return;
    try {
      const r = await panel.rotateToken();
      if (r.mcp_url) await copy(r.mcp_url);
      ui.toast('BlackHole：MCP 链接已重置，新链接已复制；请更新已配置的连接器。');
    } catch (e) { ui.toast('BlackHole: 刷新 token 失败 — ' + errText(e), 'bad'); }
    refreshHealth();
  };
  const copyDesc = async () => {
    await copy(['BlackHole provides access to the current workspace through MCP.', 'Start with guide using the supplied sessionId. Comply with its instructions throughout the session, and use that sessionId on every BlackHole call.'].join('\n'));
    ui.toast('BlackHole：连接器描述已复制。');
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
  const semanticClear = async () => {
    if ((await ui.confirm('BlackHole：清除 Devin Key 后，重启 daemon 会使 context_search 下线。', ['清除 Key'])) !== '清除 Key') return;
    try { await panel.semanticClear(); ui.toast('BlackHole：Devin Key 已清除；重启 daemon 后 context_search 下线。'); }
    catch (e) { ui.toast('BlackHole: 清除失败 — ' + errText(e), 'bad'); }
    loadSemantic();
  };
  const patchNow = async (values: Partial<SettingsValues>) => {
    const latest = server ?? (await api.settings());
    try { setServer(await api.saveSettings(latest.revision, values)); }
    catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'revision_conflict') throw e;
      const fresh = await api.settings();
      setServer(await api.saveSettings(fresh.revision, values));
    }
  };
  const addCustomAgent = async () => {
    const name = waName.trim(), raw = waUrl.trim();
    if (!name || !raw || !server) return;
    setWaName(''); setWaUrl('');
    const url = normalizeUrl(raw);
    if (!url) { ui.toast(`BlackHole: 无法识别的网址「${raw}」，示例：example.com 或 https://example.com`, 'bad'); return; }
    const custom = server.values.customWebAgents;
    if ([...AGENTS, ...custom].some((a) => a.name.toLowerCase() === name.toLowerCase())) { ui.toast(`BlackHole: 名称「${name}」已存在`, 'bad'); return; }
    try { await patchNow({ customWebAgents: [...custom, { name, url }] }); ui.toast('BlackHole：自定义站点已添加。'); }
    catch (e) { ui.toast('BlackHole: ' + errText(e), 'bad'); }
  };
  const removeCustomAgent = async (name: string) => {
    if (!server || (await ui.confirm(`BlackHole：删除自定义站点「${name}」？`, ['删除'])) !== '删除') return;
    try { await patchNow({ customWebAgents: server.values.customWebAgents.filter((a) => a.name !== name) }); ui.toast(`BlackHole：自定义站点「${name}」已删除。`); }
    catch (e) { ui.toast('BlackHole: ' + errText(e), 'bad'); }
  };

  const save = async () => {
    if (!server || !draft || cf.busy || saving) return;
    if (channelMode === 'custom' && !/^https:\/\/[^\s/]+/i.test(draft.publicBaseUrl.trim())) { ui.toast('BlackHole: 自定义公网地址需要填写可访问的 HTTPS Base URL。', 'bad'); return; }
    const values: Record<string, unknown> = {};
    const saved: string[] = [];
    for (const k of TEXT_KEYS) {
      const next = draft[k].trim();
      if (next !== serverText(server.values, k)) { values[k] = next; saved.push(FIELD[k].label); }
    }
    if (channelMode !== server.values.channelMode) { values.channelMode = channelMode; saved.push('渠道方式'); }
    if (semMode !== server.values.semanticMode) { values.semanticMode = semMode; saved.push('Devin Key 模式'); }
    const nextAgents = AGENTS.map((a) => a.name).filter((n) => agentsOn.has(n));
    if (JSON.stringify(nextAgents) !== JSON.stringify(server.values.webAgents.filter((n) => AGENTS.some((a) => a.name === n)))) { values.webAgents = nextAgents; saved.push('Web Agent 显示'); }
    setSaving(true);
    try {
      if (Object.keys(values).length) await api.saveSettings(server.revision, values as Partial<SettingsValues>);
      if (semKey.trim()) {
        try { await panel.semanticSave(semKey.trim()); saved.push('Devin Key'); }
        catch (e) { ui.toast('BlackHole: Devin Key 保存失败 — ' + errText(e), 'bad'); }
      }
      const detail = saved.length ? '（' + [...new Set(saved)].join('、') + '）' : '';
      ui.toast('BlackHole：设置已保存' + detail + '；相关改动需重启 daemon 生效。');
      await loadSettings();
      loadSemantic();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'revision_conflict') { ui.toast('设置刚在别处被修改过，已加载最新值，请重新修改后保存。', 'warn'); await loadSettings(); }
      else ui.toast('BlackHole: 保存失败 — ' + errText(e), 'bad');
    } finally { setSaving(false); }
  };

  const field = (k: TextKey, extra?: ReactNode) => (
    <div className="f" key={k}>
      <label htmlFor={k}>{FIELD[k].label}</label>
      <input id={k} type="text" spellCheck={false} value={draft?.[k] ?? ''} disabled={k === 'cloudflaredPath' && cf.busy} onChange={(e) => set(k, e.target.value)} />
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

  return (
    <div className="bhp">
      <h1>BlackHole 设置<span className="ver">{o?.version ? 'v' + o.version : ''}</span></h1>
      <div className="cockpit" id="set-overview">
        <div className="cell"><div className="ck-k">Daemon</div><div className="ck-v"><span className={'d ' + dm[0]} /><span>{dm[1]}</span></div></div>
        <div className="cell"><div className="ck-k">渠道</div><div className="ck-v"><span className={'d ' + cm[0]} /><span>{cm[1]}</span></div></div>
        <Activity health={reachable ? health : null} />
      </div>

      <div className="sec" id="set-account">账号与订阅</div>
      <AccountSection ui={ui} />

      <div className="sec" id="set-channel">公网渠道</div>
      <div className="card">
        <div className="channel-mode"><span className="lbl">渠道方式</span>
          {(['cloudflare', 'openai', 'custom'] as const).map((m) => (
            <button key={m} type="button" className={'agchip' + (channelMode === m ? ' on' : '')} aria-pressed={channelMode === m} disabled={cf.busy}
              onClick={() => { setCustomProbe({ url: '', state: 'idle', detail: '' }); setChannelMode(m); }}>{m === 'cloudflare' ? 'Cloudflare' : m === 'openai' ? 'OpenAI' : '自定义'}</button>
          ))}
        </div>
        {channelMode === 'cloudflare' ? (
          <div id="channelCloudflare">
            <div className="fgrid channel-config">{field('cloudflaredPath')}{field('publicBaseUrl')}</div>
            {!hasCfPath && <button id="cfInstall" className="secondary" type="button" disabled={cf.busy} onClick={() => void cfInstall()}>{cf.label}</button>}
            {(!hasCfPath || cf.cls !== 'hint') && <div id="cfInstallMessage" className={cf.cls} role="status" aria-live="polite">{cf.text}</div>}
            <div className="channel-required">cloudflared 由 BlackHole 启停；固定公网地址仅用于持久渠道。修改后需重启 daemon。</div>
          </div>
        ) : channelMode === 'openai' ? (
          <div id="channelOpenai">
            <div className="channel-custom-note">OpenAI Secure MCP Tunnel 请在 VS Code 的 BlackHole 设置页安装、配置与启停；只出站连接，不提供公网地址。选择此项只更改默认渠道，不会停止 Cloudflare。</div>
          </div>
        ) : (
          <div id="channelCustom">
            <div className="fgrid channel-config">
              <div className="f"><label htmlFor="customPublicBaseUrl">公网地址</label>
                <div className="channel-probe-line">
                  <input id="customPublicBaseUrl" type="text" spellCheck={false} placeholder="https://blackhole.example.com" value={draft?.publicBaseUrl ?? ''} onChange={(e) => { set('publicBaseUrl', e.target.value); setCustomProbe({ url: '', state: 'idle', detail: '' }); }} />
                  <button className="secondary" type="button" disabled={customProbe.state === 'probing'} onClick={() => void runCustomProbe()}>检测</button>
                </div>
                <div className="d">填写当前公网地址并检测；支持 HTTP/HTTPS、域名或 IP，以及自定义端口。</div>
              </div>
            </div>
            <div className="channel-custom-note">将公网 HTTPS 流量转发到 <code>{'http://127.0.0.1:' + port}</code>；隧道与反向代理由你自行维护。</div>
          </div>
        )}
        <div className="chrow channel-actions">
          <span className={'chst ' + chst.cls}>{chst.text}</span>
          <span className="sp" />
          {showQ && <button className="secondary" type="button" onClick={() => { if (requireCloudflaredPath()) void tunnel('quick'); }}>启动临时</button>}
          {showN && <button className="secondary" type="button" disabled={!hasNamed} title={hasNamed ? '启动持久渠道（固定域名）' : '持久渠道需先配置固定公网地址'} onClick={() => { if (requireCloudflaredPath()) void tunnel('named'); }}>启动持久</button>}
          {showS && <button className="secondary" type="button" onClick={() => void tunnel('stop')}>停止</button>}
          {showC && <button type="button" onClick={() => void tunnel('copy')}>复制链接</button>}
        </div>
        {cnerr && <div className={'hint ' + cnerr.cls} style={{ display: 'block' }}>{cnerr.text}</div>}
      </div>

      <div className="sec" id="set-remote">手机访问</div>
      <RemoteSection enabled={!!server?.values.remoteAccess} toast={ui.toast} confirm={(title, actions) => ui.confirm(title, actions)}
        onToggle={async (on) => { try { await patchNow({ remoteAccess: on }); } catch (e) { ui.toast('BlackHole: ' + errText(e), 'bad'); } }} />

      <div className="sec" id="set-mcp">MCP 连接</div>
      <div className="card">
        <div className="mcpurl"><span>{mcpValue ? 'MCP 链接已就绪' : channelMode === 'custom' ? '检测公网地址后生成 MCP 链接' : 'MCP 链接尚未就绪'}</span>
          <div className="mcp-actions">
            <button id="mcpCopy" type="button" disabled={!mcpValue} onClick={() => void copy(mcpValue).then(() => ui.toast('BlackHole：MCP 链接已复制。'))}>复制 MCP 链接</button>
            <button id="mcpDesc" className="secondary" type="button" disabled={!mcpValue} onClick={() => void copyDesc()}>复制连接器描述</button>
            <button id="mcpRotate" className="secondary" type="button" onClick={() => void rotateToken()}>重置 MCP 链接</button>
          </div>
        </div>
      </div>

      <div className="sec" id="set-common">常用</div>
      <div className="card">
        <div className="fgrid">
          {field('skillsDir', skills && <div className={'hint ' + skills.cls}>{skills.hint}</div>)}
          {field('connectorName')}
          <div className="f"><label htmlFor="semKey">Devin Key</label>
            <input id="semKey" type="password" spellCheck={false} autoComplete="off" placeholder="sk-…" value={semKey} onChange={(e) => setSemKey(e.target.value)} />
            <div className="chrow"><span className={'chst ' + semStatus.cls}>{semStatus.text}</span><span className="sp" />{semStatus.clear && <button className="secondary" type="button" onClick={() => void semanticClear()}>清除已存</button>}</div>
            <div className="semrow"><span className="lbl">凭据来源</span><div className="agrid">
              {SEM_MODES.map((m) => <button key={m.v} type="button" className={'agchip' + (semMode === m.v ? ' on' : '')} title={m.title} onClick={() => setSemMode(m.v)}><span className="d" />{m.t}</button>)}
            </div></div>
          </div>
        </div>
      </div>

      <div className="sec" id="set-grants">授权管理</div>
      <div className="card">
        <div className="hint" style={{ margin: '0 0 10px' }}>全局授权会保留；会话授权仅当前 daemon 生命周期有效。删除后相关操作会重新询问。</div>
        <Grants info={grants} onRemove={(s, k, id) => void grantRemove(s, k, id)} />
        <div className="btnrow" style={{ marginTop: 10 }}><button className="secondary" type="button" onClick={() => void grantsClear()}>清除全部全局授权</button></div>
      </div>

      <div className="sec" id="set-proxies">MCP Proxies</div>
      <Proxies ui={ui} />

      <details id="set-advanced"><summary>高级</summary><div className="card" style={{ marginTop: 8 }}><div className="fgrid">
        {field('tunnelProbeProxy')}
        {field('gitUsrBinPath')}
        <div className="f"><label>daemon 端口</label><div className="bhp-readonly">{port}</div><div className="d">本地 daemon 监听端口（仅 127.0.0.1）。在 VS Code 设置中修改。</div></div>
        {field('namedTunnelName')}
      </div></div></details>
      <div className="actions">
        <button type="button" disabled={saving || cf.busy} onClick={() => void save()}>保存</button>
        <button type="button" className="secondary" onClick={() => void restart()}>重启 daemon</button>
      </div>
      {ui.node}
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
      {always.map((k) => <div className="ag-row" key={'a' + k}><span className="nm" style={{ flex: 1 }}>{pretty(k)}</span><button className="del" type="button" title="删除该全局授权" onClick={() => onRemove('always', k)}>删除</button></div>)}
      {sessions.map((s) => (
        <div key={s.session_id} style={{ display: 'contents' }}>
          <div className="hint" style={{ margin: '4px 0 0' }}><b>会话授权</b> · {s.session_name || s.workspace_path || s.session_id || '未知会话'} · daemon 重启后失效</div>
          {s.grants.map((k) => <div className="ag-row" key={s.session_id + k}><span className="nm" style={{ flex: 1 }}>{pretty(k)}</span><button className="del" type="button" title="删除该会话授权" onClick={() => onRemove('session', k, s.session_id)}>删除</button></div>)}
        </div>
      ))}
    </div>
  );
}

// ─── account and subscription ──────────────────────────────────────────────
function AccountSection({ ui }: { ui: Ui }) {
  const [view, setView] = useState<AccountView | null>(null);
  const [plans, setPlans] = useState(DEFAULT_PLANS);
  const [sku, setSku] = useState<BillingSku>('pro_day');
  const [buyOpen, setBuyOpen] = useState(false);
  const [wait, setWait] = useState<BillingOrder | null>(null);
  const waitAbort = useRef<{ stopped: boolean } | null>(null);
  const load = useCallback(() => api.account().then((v) => { setView(v); return v; }, () => null), []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 10000); return () => clearInterval(t); }, [load]);
  const loggedIn = !!view?.userId;
  useEffect(() => {
    if (!loggedIn) return;
    panel.plans().then((c) => {
      if (!c.enabled || !c.plans.length) return;
      setPlans(c.plans.map((p) => ({ sku: p.sku, label: planLabel(p) })));
      setSku((s) => (c.plans.some((p) => p.sku === s) ? s : c.plans[0]!.sku));
    }, () => undefined);
  }, [loggedIn]);
  const refreshView = () => panel.accountRefresh().then(setView, () => undefined);
  const report = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : '';
    ui.toast('BlackHole：' + (BILLING_ERRORS[code] ?? '购买流程响应不符合预期，已停止。请从购买记录核对原订单，勿重复付款。'), 'warn');
  };
  const a = view?.account;
  const n = Math.max(0, Math.floor(view?.remainingSeconds ?? 0));
  const identity = a ? (a.name || 'BlackHole 用户') + ' · ' + a.email : view?.userId ? 'BlackHole 用户' : view ? '尚未登录' : '读取账号状态…';
  const subscription = !view ? '订阅状态尚未获取' : !a ? '订阅状态未验证，请登录或手动刷新' : a.status === 'suspended' ? '账号已停用' : a.status === 'pending' ? '订阅准备中'
    : n > 0 ? '剩余订阅：' + Math.floor(n / 86400) + '天 ' + Math.floor((n % 86400) / 3600) + '小时 ' + Math.floor((n % 3600) / 60) + '分钟' : '订阅已到期';

  const refresh = async () => {
    try { setView(await panel.accountRefresh()); ui.toast('BlackHole：订阅状态已刷新。'); } catch (e) { ui.toast('BlackHole：刷新失败 — ' + errText(e), 'bad'); }
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
        {view?.userId && <button className="secondary" type="button" onClick={() => void copy(view.userId!).then(() => ui.toast('BlackHole：用户 ID 已复制。'))}>复制用户 ID</button>}
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
            <span className="nm">{s.name}</span>
            <span className={'pxb ' + badge[0]}><span className="d" />{badge[1]}</span>
            {canManage && <button type="button" className={'pchip ' + (count < 0 ? 'cold' : 'filesonly')} aria-label={`管理 ${s.name} 的工具`} onClick={() => openModal(s.name)}>{count < 0 ? '未加载' : count + ' 个工具'}</button>}
            <span className="pxbtns">
              {s.status !== 'config_error' && <button type="button" className={'pxsw' + (isOff ? '' : ' on')} role="switch" aria-label={'启用 ' + s.name} aria-checked={!isOff} title={isOff ? '启用并启动 MCP' : '停用并断开 MCP'} disabled={pending.has(s.name)} onClick={() => void saveFields(s.name, { enabled: isOff })} />}
              {s.status !== 'config_error' && <button type="button" className="pxe" onClick={() => setEditing((e) => (e === s.name ? null : s.name))}>编辑</button>}
              <button type="button" className="pxe danger" onClick={() => void remove(s.name)}>删除</button>
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
      <div className="pxthr"><span className="pxth">{'工具 ' + list.length + (dupN > 0 ? ' · 重名 ' + dupN : '') + (r.cachedOnly ? ' · 缓存' : ' · 实时') + (r.ageMs != null ? ' · ' + Math.round(r.ageMs / 1000) + 's 前' : '')}</span><span className="sp" /><button type="button" disabled={!!r.disabled || data.loading} onClick={onRefresh}>刷新</button></div>
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
