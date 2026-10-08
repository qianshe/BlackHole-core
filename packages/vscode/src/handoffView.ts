/** Handoff presentation: summaries only until explicit preview; never assembles credentials. */
export const handoffStyles = `
  #handoffBanner[hidden], #handoffStatus:empty { display:none; }
  .handoffBar { display:inline-flex; align-items:baseline; gap:2px; flex:none; white-space:nowrap; font-family:var(--vscode-font-family); font-size:11px; font-weight:400; line-height:14px; }
  .handoffBar button { padding:0 2px; margin:0; border:0; border-radius:3px; background:transparent; color:var(--vscode-textLink-foreground); font:inherit; cursor:pointer; }
  .handoffBar button:hover:not(:disabled) { background:var(--vscode-toolbar-hoverBackground); }
  .handoffBar button:disabled { opacity:.5; cursor:default; }
  .handoffBar button:focus-visible, #handoffDialog button:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:1px; }
  .row .name .txt { min-width:0; }
  .row .name:has(.handoffBar) { align-items:baseline; gap:6px; }
  /* Shared intrinsic status column: keep actions aligned without reserving 7em.
     Outer tracks include row padding; subgrid preserves the existing hit targets. */
  #list[data-mode="sessions"] { display:grid; grid-template-columns:28px minmax(0,1fr) max-content 32px; column-gap:6px; align-content:start; }
  #list[data-mode="sessions"] > .row { display:grid; grid-column:1/-1; grid-template-columns:subgrid; }
  /* Explicit tracks: a row without a status must leave column 3 empty, not move ⋯ into it. */
  #list[data-mode="sessions"] > .row > .drag { grid-column:1; }
  #list[data-mode="sessions"] > .row > .main { grid-column:2; }
  #list[data-mode="sessions"] > .row > .st { grid-column:3; }
  #list[data-mode="sessions"] > .row > .ract { grid-column:4; }
  #list[data-mode="sessions"] > .empty { grid-column:1/-1; }
  #list[data-mode="sessions"] .row .st { text-align:right; }
  .row .handoffBar { margin-left:auto; border-left:1px solid var(--vscode-panel-border); padding-left:4px; }
  .row .handoffBar button:first-child { color:var(--vscode-descriptionForeground); padding:3px 6px; min-height:22px; border:1px solid var(--vscode-panel-border); border-radius:4px; }

  /* Compress all rows alike on narrow sidebars: pending state must not shift titles. */
  @media (max-width:300px) {
    #list[data-mode="sessions"] { grid-template-columns:16px minmax(0,1fr) max-content 24px; column-gap:2px; }
    .row { gap:2px; padding-left:4px; padding-right:4px; }
    .row .drag { width:12px; }
    .row .ract { width:20px; flex-shrink:0; }
    .row .name:has(.handoffBar) { gap:3px; }
    .row .handoffBar { gap:1px; padding-left:2px; }
    .row .handoffBar button { padding-inline:1px; }
  }
  #handoffBanner { flex-shrink:0; padding:6px 10px; border-bottom:1px solid var(--vscode-panel-border); }
  #handoffBanner .handoffBar { display:flex; align-items:center; flex-wrap:wrap; gap:6px; min-height:32px; white-space:normal; }
  #handoffBanner .handoffBar button { padding:3px 7px; line-height:18px; border:0; }
  #handoffBanner .handoffBar button:first-child { margin-right:auto; padding-left:0; color:var(--vscode-foreground); font-size:12px; font-weight:600; }
  #handoffStatus { padding:4px 10px 6px; margin:0; font-size:11px; line-height:1.5; overflow-wrap:anywhere; color:var(--vscode-descriptionForeground); }
  #handoffDialog { box-sizing:border-box; width:calc(100vw - 24px); max-width:680px; max-height:calc(100vh - 24px); padding:12px; border:1px solid var(--vscode-widget-border,var(--vscode-panel-border)); border-radius:6px; color:var(--vscode-foreground); background:var(--vscode-editorWidget-background,var(--vscode-sideBar-background)); box-shadow:0 6px 24px var(--vscode-widget-shadow,rgba(0,0,0,.25)); }
  #handoffDialog[open] { display:flex; flex-direction:column; gap:10px; }
  #handoffDialog::backdrop { background:rgba(0,0,0,.35); }
  #handoffDialog header { display:flex; align-items:center; justify-content:space-between; flex-shrink:0; }
  #handoffDialog h2 { margin:0; font-size:13px; font-weight:600; }
  #handoffDialog p { margin:0; font-size:11px; line-height:1.6; overflow-wrap:anywhere; flex-shrink:0; }
  #handoffTime, #handoffHint { color:var(--vscode-descriptionForeground); }
  #handoffBody { margin:0; min-height:0; padding:10px; border:1px solid var(--vscode-panel-border); border-radius:3px; background:var(--vscode-textCodeBlock-background); overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.65 var(--vscode-editor-font-family); }
  #handoffBody:empty { display:none; }
  #handoffBody:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:1px; }
  #handoffActions { display:flex; gap:6px; flex-wrap:wrap; flex-shrink:0; }
  #handoffActions button { padding:4px 8px; line-height:18px; border:1px solid var(--vscode-widget-border,var(--vscode-panel-border)); }
  #handoffNotice { color:var(--vscode-descriptionForeground); }
  #handoffNotice:empty { display:none; }
`;
export const handoffMarkup = `
  <section id="handoffBanner" hidden aria-label="Handoff"></section>
  <p id="handoffStatus" role="status" aria-live="polite"></p>
  <dialog id="handoffDialog" aria-labelledby="handoffTitle" aria-describedby="handoffHint">
    <header><h2 id="handoffTitle">Handoff · 接力上下文</h2><button class="ib" id="handoffClose" type="button" aria-label="关闭 Handoff" autofocus>×</button></header>
    <p id="handoffTime"></p><pre id="handoffBody" tabindex="0"></pre>
    <p id="handoffHint">复制包含工作区访问凭据的完整提示词，仅交给预期接手者。</p>
    <div id="handoffActions" class="handoffBar"><button id="handoffConnector" type="button">复制连接器</button><button id="handoffSandbox" type="button">复制沙箱</button></div>
    <p id="handoffNotice" role="status" aria-live="polite"></p>
  </dialog>
`;
export const handoffScript = String.raw`
function mountHandoffView(document, send) {
  const get = id => document.getElementById(id), dialog = get('handoffDialog'), body = get('handoffBody');
  const hint = '复制包含工作区访问凭据的完整提示词，仅交给预期接手者。';
  const feedback = new Map(); let sessions = new Map(), bars = [], data = {}, sequence = 0, busy = null, preview = null, trigger = null;
  const key = s => s.id + ':' + s.pending_handoff.id;
  const same = (a,b) => a && b && a.id === b.id && a.handoffId === b.handoffId && a.requestId === b.requestId;
  const valid = r => r && sessions.get(r.id)?.pending_handoff?.id === r.handoffId;
  const request = (s,type,kind) => ({type,id:s.id,handoffId:s.pending_handoff.id,requestId:String(++sequence),...(kind?{kind}: {})});
  function say(text) { get('handoffStatus').textContent=text; get('handoffNotice').textContent=text; }
  function update() {
    for(const {s,buttons} of bars) {
      const text=feedback.get(key(s)) || '';
      buttons[0].textContent='Handoff';
      buttons[0].title=text || '查看 Handoff（可选）';
      buttons[0].disabled=data.handoffSynchronized===false;
      for(const b of buttons.slice(1)) { b.disabled=!!busy || data.handoffSynchronized===false || s.status!=='active'; b.title=s.status!=='active'?'会话暂停或不可用，恢复后复制。':hint; }
    }
    for(const id of ['handoffConnector','handoffSandbox']) {
      get(id).disabled=!!busy || !valid(preview) || data.handoffSynchronized===false || sessions.get(preview?.id)?.status!=='active';
      get(id).title=hint;
    }
  }
  function close() {
    preview=null; if(dialog.open) dialog.close(); body.textContent=''; get('handoffTime').textContent='';
    send({type:'cancelHandoffPreview'});
    if(trigger?.isConnected) trigger.focus();
    else if(trigger) { const replacement=[...document.querySelectorAll('button[data-session-id]')].find(b=>b.dataset.sessionId===trigger.dataset.sessionId); replacement?.focus(); }
    trigger=null; update();
  }
  function copy(s,kind) {
    if(!s?.pending_handoff || busy || data.handoffSynchronized===false || s.status!=='active') return;
    busy=request(s,'copyHandoff',kind); feedback.set(key(s),'复制中…'); say('Handoff 复制中…'); update(); send(busy);
  }
  function open(s,button) {
    if(data.handoffSynchronized===false) return;
    preview=request(s,'previewHandoff'); trigger=button; body.textContent='';
    get('handoffTime').textContent='正在读取 Handoff…'; get('handoffNotice').textContent='';
    if(!dialog.open) dialog.showModal(); update(); send(preview);
  }
  function attach(parent,s,compact=true) {
    if(!s.pending_handoff) return;
    const bar=document.createElement('span'); bar.className='handoffBar';
    const buttons=(compact?['Handoff']:['Handoff','连接器','沙箱']).map((label,i)=>{
      const b=document.createElement('button'); b.type='button'; b.textContent=label;
      b.dataset.sessionId=s.id; b.dataset.handoffId=s.pending_handoff.id; b.dataset.handoffAction=String(i);
      b.setAttribute('aria-label',i===0?'查看 Handoff（可选）':'复制 Handoff · '+label);
      if(i===0)b.setAttribute('aria-haspopup','dialog');
      b.addEventListener('click',e=>{e.stopPropagation(); i===0?open(s,b):copy(s,i===1?'connector':'sandbox');});
      b.addEventListener('contextmenu',e=>e.stopPropagation());
      b.addEventListener('mousedown',e=>e.stopPropagation());
      bar.appendChild(b); return b;
    });
    parent.appendChild(bar); bars.push({s,buttons}); update();
  }
  get('handoffClose').addEventListener('click',close);
  dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  dialog.addEventListener('close',()=>{ if(preview) close(); body.textContent=''; });
  get('handoffConnector').addEventListener('click',()=>copy(sessions.get(preview?.id),'connector'));
  get('handoffSandbox').addEventListener('click',()=>copy(sessions.get(preview?.id),'sandbox'));
  return {
    attach,
    render(next) {
      const navigated=data.mode!==next.mode || data.selected?.id!==next.selected?.id || data.handoffGeneration!==next.handoffGeneration;
      const recovered=data.handoffSynchronized===false && next.handoffSynchronized===true;
      if(recovered)say('');
      data=next; sessions=new Map((next.sessions||[]).map(s=>[s.id,s])); bars=[];
      const live=new Set([...sessions.values()].filter(s=>s.pending_handoff).map(key));
      for(const k of feedback.keys())if(!live.has(k))feedback.delete(k);
      if(navigated) { busy=null; say(''); }
      if(preview && (navigated || !valid(preview) || next.handoffSynchronized===false))close();
      if(busy && !valid(busy)){busy=null;say('Handoff 已更新，请重试复制。');}
      const banner=get('handoffBanner'); banner.replaceChildren();
      const selected=next.mode==='calls'?sessions.get(next.selected?.id):null;
      banner.hidden=!selected?.pending_handoff;
      if(!banner.hidden)attach(banner,selected,false);
      if(next.handoffSynchronized===false)say('Handoff 未同步，恢复连接后重试。');
      else if(next.handoffUnsupported)say('当前服务不支持 Handoff 快捷操作，请更新服务。');
      update();
    },
    copied(message) {
      if(!same(busy,message))return;
      busy=null;
      if(valid(message)) {
        const text=message.ok?'Handoff 提示词已复制；仅交给预期接手者。':message.error||'Handoff 复制失败，请重试。';
        feedback.set(key(sessions.get(message.id)),text); say(text);
      }
      update();
    },
    preview(message) {
      if(!same(preview,message)||!valid(message)||!dialog.open)return;
      if(message.ok && message.handoff?.id===preview.handoffId) {
        body.textContent=message.handoff.content;
        get('handoffTime').textContent='保存于 '+new Date(message.handoff.created_at).toLocaleString();
      } else { body.textContent=''; get('handoffTime').textContent=''; say(message.error||'Handoff 无法读取，请重试。'); }
    },
  };
}
`;
