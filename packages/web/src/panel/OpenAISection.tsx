// OpenAI Secure MCP Tunnel tab of the Web settings panel: the same flows as the VS Code
// settings page (packages/vscode/src/configPanel.ts, channelOpenai) — one-click install
// of the pinned runtime, Runtime API Key save/clear, start/stop and diagnostics. The
// daemon serves these routes to this computer only; the API key is never read back.
import { useState, type ReactNode } from 'react';
import { ApiError, panel, type Health, type OpenAITunnelView } from '../api';
import { OPENAI_ERRORS, OPENAI_LINK_URLS, OPENAI_STATUS_LABELS } from './openaiCopy';

const ERRORS: Record<string, string> = {
  ...OPENAI_ERRORS,
  // Web autosaves each field: the settings are "unsaved" only when a field failed to save.
  unsaved_settings: 'Tunnel ID 或 tunnel-client 路径还没有保存成功；请先修正上面标红的输入。',
};
const INSTALL_TEXT = '下载并校验 OpenAI 官方 tunnel-client runtime（纯 runtime 版，不含 cloudflared）；验证通过后自动保存路径，不会启动渠道。';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Status = { text: string; cls: string };

/** Status chip shared by this tab and the settings cockpit (VS Code renderStatus, openai branch). */
export function openaiStatus(health: Health | null, reachable: boolean, clientPath: string): Status {
  if (!reachable) return { text: 'daemon 未运行', cls: 'dim' };
  const v = health?.openai_tunnel ?? null;
  if (!clientPath.trim() && !v?.run_id) return { text: '未安装 tunnel-client', cls: 'dim' };
  if (!v) return { text: 'tunnel-client 已就绪', cls: 'ok' };
  const [tone, label] = OPENAI_STATUS_LABELS[v.status] ?? ['', v.status];
  return { text: 'OpenAI · ' + label, cls: tone || 'dim' };
}

export interface OpenAISectionProps {
  health: Health | null;
  reachable: boolean;
  /** Current (draft) tunnel-client path; install and the status chip follow it. */
  clientPath: string;
  /** The path and Tunnel ID fields, rendered by the panel's autosave form. */
  fields: (installing: boolean) => ReactNode;
  confirm: (title: string, actions: string[], detail?: ReactNode) => Promise<string | null>;
  toast: (text: string, tone?: 'info' | 'warn' | 'bad') => void;
  /** Wait for pending saves and make the daemon hold the fields shown; resolves the settings revision. */
  prepareStart: () => Promise<number>;
  /** Save a verified path if the field still shows `previous`; false when the settings moved on. */
  onInstalled: (previous: string, path: string) => Promise<boolean>;
}

export function OpenAISection({ health, reachable, clientPath, fields, confirm, toast, prepareStart, onInstalled }: OpenAISectionProps) {
  const v = reachable ? health?.openai_tunnel ?? null : null;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ cls: string; text: string } | null>(null);
  const [key, setKey] = useState('');
  const [install, setInstall] = useState({ busy: false, cls: 'hint', text: INSTALL_TEXT, keep: false });
  const live = !!v && (v.status === 'starting' || v.status === 'ready' || v.status === 'recovering');
  const hasPath = clientPath.trim() !== '';
  const off = busy || !v;

  const errorText = async (e: unknown): Promise<string> => {
    const code = e instanceof ApiError ? e.code : e instanceof Error ? e.message : String(e);
    if (ERRORS[code]) return ERRORS[code];
    const view = await panel.openai().catch(() => null);
    if (view && view.reason_code === code && view.reason) return view.reason;
    return 'OpenAI 渠道操作失败（' + code + '）。';
  };
  /** One action at a time, against the daemon that answers right now (daemon_id + credential revision). */
  const act = async (fn: (daemonId: string, view: OpenAITunnelView) => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setResult({ cls: '', text: '处理中…' });
    try {
      const h = await panel.health();
      const view = h.openai_tunnel;
      if (!view || h.openai_tunnel_api_version !== 1 || !h.daemon_id) throw new Error('openai_tunnel_unsupported');
      const text = await fn(h.daemon_id, view);
      setResult(text ? { cls: 'ok', text } : null);
    } catch (e) {
      setResult({ cls: 'bad', text: await errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const saveKey = () => act(async (id, view) => {
    const k = key.trim();
    if (!k) throw new Error('empty_api_key');
    const r = await panel.openaiSaveKey(id, view.credential_revision, k);
    setKey('');
    return r.pending_restart ? 'Runtime API Key 已保存；重新启动 OpenAI 渠道后生效。' : 'Runtime API Key 已保存。';
  });
  const clearKey = async () => {
    if ((await confirm('BlackHole：清除 Runtime API Key 会先停止 OpenAI 渠道，再删除本机保存的密钥。', ['清除密钥'])) !== '清除密钥') return;
    await act(async (id, view) => {
      await panel.openaiClearKey(id, view.credential_revision);
      return 'Runtime API Key 已删除；OpenAI 渠道已停止。';
    });
  };
  const start = () => act(async (id, view) => {
    const revision = await prepareStart();
    const r = await panel.openaiStart(id, revision, view.credential_revision);
    return r.status === 'ready' ? 'OpenAI 渠道已就绪。' : 'OpenAI 渠道正在启动；就绪后状态会自动更新。';
  });
  const stop = () => act(async (id, view) => {
    await panel.openaiStop(id, view.run_id);
    return 'OpenAI 渠道已停止。';
  });
  const diagnostics = () => act(async () => {
    const text = JSON.stringify(await panel.openaiDiagnostics(), null, 2);
    const pick = await confirm('OpenAI 渠道诊断（本机观测，已脱敏）', ['复制'], <pre className="bhp-diag">{text}</pre>);
    if (pick === '复制') {
      const ok = await navigator.clipboard.writeText(text).then(() => true, () => false);
      toast(ok ? 'BlackHole：诊断信息已复制。' : 'BlackHole：复制失败，请手动选择文本。', ok ? 'info' : 'warn');
    }
    return null;
  });
  const runInstall = async () => {
    if (install.busy) return;
    const previous = clientPath;
    setInstall({ busy: true, cls: 'hint', text: '正在下载并校验 tunnel-client（约 7.5 MB）；不会启动渠道。', keep: true });
    const done = (cls: string, text: string) => setInstall({ busy: false, cls, text, keep: true });
    try {
      let job = await panel.openaiInstallStart();
      while (job.state === 'running') { await sleep(1000); job = await panel.openaiInstall(); }
      if (job.state === 'error') { done('hint bad', '安装失败：' + job.error); return; }
      if (job.state !== 'done') { done('hint bad', '安装未完成；请重试。'); return; }
      if (!(await onInstalled(previous, job.path))) { done('hint', `设置已在别处变化，未自动保存。已验证文件：${job.path}`); return; }
      done('hint ok', (job.installed ? 'tunnel-client ' + (job.version ? job.version + ' ' : '') + '安装完成：' : '已检测到可用的 tunnel-client，未下载：') + job.path + '。路径已保存；尚未启动 OpenAI 渠道。');
    } catch (e) {
      done('hint bad', '安装失败：' + (await errorText(e)));
    }
  };

  const keyState: Status = !v ? { text: reachable && health?.version ? '当前 daemon 不支持 OpenAI 渠道（请重启 daemon）' : 'daemon 未连接', cls: 'dim' }
    : v.credential_configured === null ? { text: '无法读取已保存的密钥', cls: 'bad' }
    : v.credential_configured ? (v.pending_restart ? { text: '已保存 · 重新启动渠道后生效', cls: 'warn' } : { text: '已保存', cls: 'ok' })
    : { text: '未保存', cls: 'dim' };
  const st = openaiStatus(health, reachable, clientPath);
  const reason = v?.reason ? { text: v.reason, cls: v.status === 'error' ? 'bad' : 'warn' } : null;

  return (
    <div id="channelOpenai">
      <div className="fgrid channel-config">{fields(install.busy)}</div>
      {!hasPath && <button id="oaInstall" className="secondary" type="button" disabled={install.busy} onClick={() => void runInstall()}>{install.busy ? '安装中…' : '一键安装'}</button>}
      {(!hasPath || install.keep) && <div id="oaInstallMessage" className={install.cls} role="status" aria-live="polite">{install.text}</div>}
      <div className="fgrid channel-config">
        <div className="f" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="oaKey">Runtime API Key</label>
          <div className="channel-probe-line">
            <input id="oaKey" type="password" spellCheck={false} autoComplete="off" placeholder="保存后只存在本机" value={key}
              onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && key.trim()) void saveKey(); }} />
            <button className="secondary" type="button" disabled={off || !key.trim()} onClick={() => void saveKey()}>保存密钥</button>
            {v?.credential_configured && <button className="secondary" type="button" disabled={off} onClick={() => void clearKey()}>清除密钥</button>}
          </div>
          <div className="chrow"><span className={'chst ' + keyState.cls}>{keyState.text}</span></div>
          <div className="d">OpenAI Platform 中创建的 Runtime API Key（需 Tunnels Read/Use 权限）。只保存在本机，不写入设置文件，也不会回显。</div>
        </div>
      </div>
      <div className="chrow channel-actions">
        <span className={'chst ' + st.cls}>{st.text}</span>
        <span className="sp" />
        {!live && <button type="button" disabled={off} onClick={() => void start()}>启动 OpenAI 渠道</button>}
        {(live || v?.status === 'stopping') && <button className="secondary" type="button" disabled={off} onClick={() => void stop()}>停止 OpenAI 渠道</button>}
        <button className="secondary" type="button" disabled={off} onClick={() => void diagnostics()}>诊断</button>
      </div>
      {reason && <div className={'hint ' + reason.cls} style={{ display: 'block' }}>{reason.text}</div>}
      {result && <div className={'hint ' + result.cls} role="status" aria-live="polite" style={{ display: 'block' }}>{result.text}</div>}
      <div className="channel-required">准备：在 <a href={OPENAI_LINK_URLS.platform} target="_blank" rel="noopener noreferrer">OpenAI Platform 隧道设置</a> 创建 Tunnel 并复制 Tunnel ID；Runtime API Key 需 Tunnels Read/Use 权限（创建/编辑 Tunnel 另需 Manage），Tunnel 还需关联要使用的 ChatGPT workspace。这些权限本地无法验证，诊断只能提示检查。</div>
      <div className="channel-required">接入 ChatGPT：启动本渠道后，在 <a href={OPENAI_LINK_URLS.chatgpt} target="_blank" rel="noopener noreferrer">chatgpt.com/plugins</a> 点 + 新建开发者模式应用（需先在 设置 → 安全 开启开发者模式），Connection 选「Tunnel」并选中该 Tunnel ID；应用名建议与「连接器名称」一致，复制的连接器提示词才能 @ 到它。</div>
      <div className="channel-required">OpenAI Secure MCP Tunnel 只建立出站连接，不提供公网地址，所以只支持连接器提示词，不支持沙箱直连；与 Cloudflare 渠道互不影响，切换渠道方式不会停止任何渠道。</div>
    </div>
  );
}
