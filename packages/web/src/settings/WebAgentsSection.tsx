import { useRef, useState } from 'react';
import { WEB_AGENT_PRESETS } from '../../../contracts/src/web-agent-presets';
import type { SettingsValues } from '../api';
type Values = Pick<SettingsValues, 'webAgents' | 'customWebAgents'>;
export function WebAgentsSection({ values, save, confirm }: {
  values?: Values;
  save(patch: Partial<Values>): Promise<boolean>;
  confirm(title: string, actions: string[]): Promise<string | null>;
}) {
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const run = async (action: () => Promise<void>) => {
    if (lock.current || !values) return; lock.current = true; setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { lock.current = false; setBusy(false); }
  };
  const store = async (patch: Partial<Values>) => { if (!await save(patch)) throw Error('保存失败或配置已在别处修改，请核对最新值。'); };
  const add = () => run(async () => {
    const n = name.trim(), raw = url.trim();
    if (!n || n.length > 80) throw Error('请输入 1–80 个字符的站点名称。');
    if ([...WEB_AGENT_PRESETS, ...(values?.customWebAgents ?? [])].some(x => x.name.toLowerCase() === n.toLowerCase())) throw Error('该站点名称已存在。');
    let parsed: URL;
    try { parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { throw Error('请输入有效的 HTTP(S) 网址。'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw Error('网址仅支持不带凭据的 HTTP(S) 地址。');
    await store({ customWebAgents: [...(values?.customWebAgents ?? []), { name: n, url: parsed.href }] }); setName(''); setUrl('');
  });
  return <section aria-label="Web Agent 显示">
    <div className="sec">Web Agent 显示<small>控制客户端网站选择器中的站点，不会启动或打开网页。</small></div>
    <div className="card">
      <div className="agrid">{WEB_AGENT_PRESETS.map(item => <button type="button" className={'agchip' + (values?.webAgents.includes(item.name) ? ' on' : '')} aria-pressed={!!values?.webAgents.includes(item.name)} title={item.description} disabled={!values || busy} key={item.name} onClick={() => void run(async () => {
        const current = values?.webAgents ?? [];
        await store({ webAgents: current.includes(item.name) ? current.filter(x => x !== item.name) : [...current, item.name] });
      })}>{item.name}</button>)}</div>
      <div className="subsec">自定义站点</div>
      {(values?.customWebAgents ?? []).map(item => <div className="ag-row" key={item.name}><span className="nm">{item.name}</span><span className="u">{item.url}</span><button type="button" className="del" disabled={busy} aria-label={'删除 ' + item.name} onClick={() => void run(async () => { if (await confirm('删除站点「' + item.name + '」？', ['删除']) === '删除') await store({ customWebAgents: (values?.customWebAgents ?? []).filter(x => x.name !== item.name) }); })}>删除</button></div>)}
      <div className="fgrid" style={{ marginTop: 12 }}><div className="f"><label htmlFor="agentSiteName">站点名称</label><input id="agentSiteName" value={name} disabled={busy} placeholder="如 Kimi" onChange={e => setName(e.target.value)} /></div><div className="f"><label htmlFor="agentSiteUrl">网站地址</label><input id="agentSiteUrl" value={url} disabled={busy} placeholder="https://example.com" onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add(); }} /></div></div>
      <div className="btnrow" style={{ marginTop: 10 }}><button type="button" disabled={!values || busy || !name.trim() || !url.trim()} onClick={() => void add()}>添加站点</button><span className="hint" role="status">{error || (busy ? '保存中…' : '')}</span></div>
    </div>
  </section>;
}
