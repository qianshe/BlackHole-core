import { useEffect, useState } from 'react';
import { request } from '../api';
import { settingsHost, type SettingsHostInfo } from './host';

/** The only host-specific fields; rendered with the same shared form primitives. */
export function HostRuntimeSection() {
  const [base, setBase] = useState<SettingsHostInfo | null>(null);
  const [draft, setDraft] = useState({ port: '', pollIntervalMs: '', daemonEntry: '' });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => {
    if (settingsHost().kind !== 'vscode') return;
    let alive = true;
    void request<SettingsHostInfo>('/host/info').then(info => {
      if (!alive) return;
      setBase(info); setDraft({ port: String(info.port), pollIntervalMs: String(info.pollIntervalMs), daemonEntry: info.daemonEntry ?? '' });
    }, () => { if (alive) setMessage('读取宿主配置失败，请重新打开设置。'); });
    return () => { alive = false; };
  }, []);
  if (settingsHost().kind !== 'vscode') return null;
  const save = async () => {
    if (!base || busy) return;
    const keys = ['port', 'pollIntervalMs', ...(base.environment === 'test' ? ['daemonEntry'] : [])] as const;
    const values: Record<string, string | number> = {}, expected: Record<string, unknown> = {};
    for (const key of keys) {
      const name = key as keyof typeof draft;
      const value = name === 'daemonEntry' ? draft[name].trim() : Number(draft[name]);
      if (value !== base[name]) { values[name] = value; expected[name] = base[name]; }
    }
    if (!Object.keys(values).length) { setMessage('没有待保存的更改。'); return; }
    setBusy(true); setMessage('保存中…');
    try {
      const next = await request<SettingsHostInfo>('/host/settings', { method: 'PATCH', body: JSON.stringify({ values, expected }) });
      setBase(next); setDraft({ port: String(next.port), pollIntervalMs: String(next.pollIntervalMs), daemonEntry: next.daemonEntry ?? '' });
      setMessage('宿主配置已保存。端口或本地服务入口变化由扩展应用，可能短暂中断连接。');
    } catch (e) { setMessage(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return <section aria-label="VS Code 宿主配置">
    <div className="sec">VS Code 宿主</div><div className="card">
      <div className="fgrid">
        <div className="f"><label htmlFor="hostPort">daemon 端口</label><input id="hostPort" type="number" min="1024" max="65535" disabled={!base || busy} value={draft.port} onChange={e => setDraft(d => ({ ...d, port: e.target.value }))}/><div className="d">仅监听 127.0.0.1，不是直连数据端口。</div></div>
        <div className="f"><label htmlFor="hostPoll">轮询间隔（毫秒）</label><input id="hostPoll" type="number" min="250" max="60000" disabled={!base || busy} value={draft.pollIntervalMs} onChange={e => setDraft(d => ({ ...d, pollIntervalMs: e.target.value }))}/></div>
        {base?.environment === 'test' && <div className="f fwide"><label htmlFor="hostEntry">自定义本地服务入口（开发用）</label><input id="hostEntry" disabled={busy} value={draft.daemonEntry} onChange={e => setDraft(d => ({ ...d, daemonEntry: e.target.value }))}/><div className="d">只替换本地后端，不改变界面或云端服务。正常使用留空。</div></div>}
      </div>
      <div className="settings-page-save"><span className="hint" role="status">{message || '只保存这里修改的宿主字段。'}</span><button disabled={!base || busy} onClick={() => void save()}>保存宿主设置</button></div>
    </div>
  </section>;
}
