// Browser-only fixture adapter. Production HTML and handlers are unchanged;
// every host write is recorded and answered with synthetic state, never a daemon call.
export function previewBootstrap(frames, qr) {
  return `(${fixtureAdapter.toString()})(${JSON.stringify(frames).replaceAll('<', '\\u003c')},${JSON.stringify(qr).replaceAll('<', '\\u003c')});`;
}
function fixtureAdapter(frames, qr) {
  window.__uiMessages = [];
  window.__externalRequests = [];
  window.fetch = async (...args) => { window.__externalRequests.push(String(args[0])); throw Error('Network disabled in fixture'); };
  const send = data => window.dispatchEvent(new MessageEvent('message', { data }));
  const direct = { type:'directAccess', revision:1, on:false, port:7307, url:'', proxyUrl:'', aiDefaultRoute:'auto' };
  const endpoint = 'http://192.0.2.10:7307';
  const remote = { enabled:true, available:true, reason:null, origin:endpoint, kind:'fixed', endpoints:[{origin:endpoint,kind:'fixed',scope:'private',verification:{state:'unverified'}}], devices:[], requests:[] };
  const listener = () => ({enabled:direct.on,port:direct.port,state:direct.on?'listening':'off',listening:direct.on,mode:direct.on?'direct':'off',bind_host:direct.on?'0.0.0.0':null,target:'http://127.0.0.1:'+direct.port,origin:direct.url||null,proxy_origin:null,addresses:direct.on?['192.0.2.10','100.80.0.2']:[],error:null});
  const status = frames.findLast(x => x.type === 'init')?.overview || {};
  function publish() {
    send({...direct,listener:listener()});
    const route = direct.aiDefaultRoute === 'auto' ? direct.on?'direct':'cloudflare' : direct.aiDefaultRoute;
    const needs = route==='direct'&&direct.on&&!direct.url;
    const url = route==='direct'&&direct.on&&direct.url?direct.url+'/mcp/fixture':null;
    send({type:'status',overview:{...status,daemon:'running',channelMode:'cloudflare',mcpUrl:url,connection_routes:{selected_route:route,preferred_mcp_url:url,preferred_mcp_kind:url?'direct':null,preferred_mcp_scope:url?'public':null,needs_choice:needs,connector_ready:!!url,connector_kind:url?'direct':null,reason:needs?'direct_multiple':null,openai:'off',mcp_candidates:[]}}});
  }
  window.acquireVsCodeApi = () => ({getState:()=>({}),setState(){},postMessage(m){
    window.__uiMessages.push(m);
    setTimeout(() => {
      if(m.type==='ready') { frames.forEach(send); publish(); send({type:'remote',view:remote}); }
      else if(m.type==='directAccessToggle') { direct.on=m.on; if(m.on)direct.url=m.url; direct.revision++; publish(); send({type:'directBusy',busy:false}); }
      else if(['directPort','directAccessUrl','channelProxyUrl','aiDefaultRoute'].includes(m.type)) {
        const value=m.port??m.url??m.route;
        const field={directPort:'port',directAccessUrl:'url',channelProxyUrl:'proxyUrl',aiDefaultRoute:'aiDefaultRoute'}[m.type];
        direct[field]=value; direct.revision++;
        send({type:'directSaveState',keys:[m.type],state:'saved',values:{[m.type]:value}}); publish();
      } else if(m.type==='remote'&&m.action==='pair') {
        send({type:'remoteQr',requestId:m.requestId,url:endpoint+'/#pair=FIXTURE_NOT_A_REAL_CODE',expiresAt:new Date(Date.now()+300000).toISOString(),kind:'fixed',...qr});
        send({type:'remotePairDone',requestId:m.requestId});
      } else if(m.type==='save') { send({type:'manualSaved',values:m.values}); const initial=frames.findLast(x=>x.type==='init'); if(initial)send(initial); }
      else if(m.type==='autosave')send({type:'autosaved',ok:true,values:m.values,keys:Object.keys(m.values||{}),message:'已自动保存（夹具）'});
    },20);
  }});
}
