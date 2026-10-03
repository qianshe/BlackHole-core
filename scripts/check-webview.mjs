// Build guard: verify every webview's embedded browser script is valid JS, and
// behaviorally exercise the settings page's MCP-proxies render path.
//
// Why: the bundle embeds HTML as a template literal, so Node never parses the
// inner <script> at build time — only the browser does. A single bad line (e.g.
// an over-escaped regex literal) silently blanks the whole webview. This
// extracts each script, resolves its runtime interpolations, and syntax-checks
// it. On top of that, the settings script (the one carrying renderProxies) is
// executed against a minimal DOM stub so the card buttons, the auto-load of
// per-MCP tool lists and the click delegation are actually asserted — that code
// has no other test surface (proxy E2E only drives the control API).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
// An explicit local build path lets feature tests verify fresh output without replacing the installed/dev dist.
const bundle = readFileSync(process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, '..', 'packages', 'vscode', 'dist', 'extension.js'), 'utf8');

// Interpolations the webview scripts embed, with the value the browser sees.
const SUBS = {
  '${nonce}': 'abc123',
  '${csp}': 'default-src none',
  '${mermaidConfigs}': '{"dark":{},"default":{}}',
  '${JSON.stringify(KEYS)}': '["port"]',
  '${JSON.stringify([...AUTO_SAVE_KEYS])}': '["channelMode","connectorName","openaiTunnelClientPath","openaiTunnelId","pollIntervalMs"]',
  '${sidebarIcons()}': '{"plus":"<svg></svg>","globe":"<svg></svg>","gear":"<svg></svg>","refresh":"<svg></svg>","more":"<svg></svg>","warn":"<svg></svg>"}',
  // Read the literal from this exact bundle, not a potentially newer source tree.
  '${handoffScript}': (() => {
    if (!bundle.includes('${handoffScript}')) return '';
    const literal = bundle.match(/\b(?:var|const) handoffScript = (String\.raw`(?:\\[\s\S]|[^`])*`);/)?.[1];
    if (!literal) throw new Error('Cannot resolve the bundled handoff browser script');
    return vm.runInNewContext(literal, {}, { timeout: 1000 });
  })(),
};

function resolve(raw) {
  const applySubs = (input) => {
    let out = input;
    for (const [k, v] of Object.entries(SUBS)) out = out.split(k).join(v);
    return out;
  };
  // esbuild may preserve outer template literals, so interpolation markers can
  // appear either before or after escape restoration. Resolve both shapes.
  let s = applySubs(raw);
  s = s.replace(/\\\\/g, '\\').replace(/\\`/g, '`').replace(/\\\$/g, String.fromCharCode(36));
  return applySubs(s);
}

// ── minimal DOM stub: just enough to run the settings page script ──────────
function runProxiesBehavior(script) {
  const fails = [];
  const assert = (cond, msg) => {
    if (!cond) fails.push(msg);
  };
  const posted = [];
  const handlers = new Map(); // element id -> [{type, fn}]
  const panels = new Map(); // server name -> tool-list panel element
  const editPanels = new Map(); // server name -> edit panel element
  const toolBtns = new Map(); // server name -> 工具 button element
  const countChips = new Map(); // server name -> count chip element

  // A real browser decodes entities when you read a <textarea>'s .value; the stub
  // must do the same, otherwise escaped JSON (&quot; / &#34;) looks like a mismatch.
  const decodeEntities = (s) => String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

  const makeEl = (id) => {
    const el = {
      id,
      _html: '',
      style: {},
      dataset: {},
      className: '',
      textContent: '',
      value: '',
      disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener(type, fn) {
        if (!handlers.has(id)) handlers.set(id, []);
        handlers.get(id).push({ type, fn });
      },
      removeEventListener() {},
      children: [], isConnected: true, hidden: false, offsetWidth: 220, offsetHeight: 70,
      appendChild(child) { this.children.push(child); child.parentElement = this; child.isConnected = true; },
      remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this); },
      focus() { document.activeElement = this; },
      getBoundingClientRect: () => ({left:100,top:80,bottom:94}),
      getAttribute: (k) => (k in el.__attrs ? el.__attrs[k] : null),
      setAttribute(k, value) { el.__attrs[k] = String(value); },
      querySelector(sel) {
        if (sel === '.pxjson') return el.__json || null;
        if (sel === '.form-msg') return el.__msg || null;
        const field = /^\[data-edit-field="([^"]+)"\]$/.exec(sel)?.[1];
        if (field) return el.__fields?.[field] || null;
        return null;
      },
      // only the proxies-card lookups are exercised: scan the last rendered HTML
      querySelectorAll(sel) {
        if (sel === '[data-edit-when]') return el.__when || [];
        const attr = sel === '[data-panel]' ? 'data-panel'
          : sel === '[data-edit-panel]' ? 'data-edit-panel'
            : sel === '[data-tools]' ? 'data-tools'
              : sel === '[data-count]' ? 'data-count'
                : null;
        if (attr === null) return [];
        const names = [...el._html.matchAll(new RegExp(attr + '="([^"]*)"', 'g'))].map((m) => m[1]);
        return names.map((n) => (
          attr === 'data-panel' ? panelEl(n)
            : attr === 'data-edit-panel' ? editPanelEl(n)
              : attr === 'data-count' ? countChipEl(n)
                : toolBtnEl(n)
        ));
      },
    };
    el.__attrs = {};
    Object.defineProperty(el, 'innerHTML', {
      get: () => el._html,
      set: (v) => {
        el._html = String(v);
        // re-rendering the card list rebuilds every child node in a real DOM:
        // drop the cached panels/buttons so lookups return fresh, empty elements
        if (id === 'pxBody') { panels.clear(); editPanels.clear(); toolBtns.clear(); countChips.clear(); }
        // when an edit panel is rendered, expose its textarea/message for the test
        if (id.startsWith('edit:')) {
          const textareas = [...String(v).matchAll(/<textarea([^>]*)>([\s\S]*?)<\/textarea>/g)];
          el.__json = { value: decodeEntities((textareas.find((m) => /class="pxjson"/.test(m[1])) || [, , ''])[2]) };
          el.__msg = { className: '', textContent: '' };
          el.__fields = {};
          for (const m of String(v).matchAll(/<(?:input|select|textarea)([^>]*data-edit-field="([^"]+)"[^>]*)>([\s\S]*?)(?:<\/(?:select|textarea)>)?/g)) {
            const attrs = m[1] || '';
            const name = m[2];
            let value = decodeEntities((/value="([^"]*)"/.exec(attrs) || [, ''])[1]);
            if (name === 'transport') value = /<option value="http" selected>/.test(String(v)) ? 'http' : 'stdio';
            if (m[3] && name === 'args') value = decodeEntities(m[3].replace(/<[^>]+>/g, ''));
            el.__fields[name] = { value, addEventListener() {} };
          const argsTa = textareas.find((m) => /data-edit-field="args"/.test(m[1]));
          if (argsTa) el.__fields.args = { value: decodeEntities(argsTa[2]), addEventListener() {} };
          }
          el.__when = [...String(v).matchAll(/data-edit-when="([^"]+)"/g)].map((m) => ({ hidden: false, getAttribute: (k) => k === 'data-edit-when' ? m[1] : null }));
        }
      },
    });
    return el;
  };
  const panelEl = (name) => {
    if (!panels.has(name)) {
      const p = makeEl('panel:' + name);
      p.__attrs['data-panel'] = name;
      panels.set(name, p);
    }
    return panels.get(name);
  };
  const editPanelEl = (name) => {
    if (!editPanels.has(name)) {
      const p = makeEl('edit:' + name);
      p.__attrs['data-edit-panel'] = name;
      p.style.display = 'none';
      editPanels.set(name, p);
    }
    return editPanels.get(name);
  };
  const toolBtnEl = (name) => {
    if (!toolBtns.has(name)) {
      const b = makeEl('tools:' + name);
      b.__attrs['data-tools'] = name;
      toolBtns.set(name, b);
    }
    return toolBtns.get(name);
  };
  const countChipEl = (name) => {
    if (!countChips.has(name)) {
      const c = makeEl('count:' + name);
      c.__attrs['data-count'] = name;
      c.className = 'pchip';
      countChips.set(name, c);
    }
    return countChips.get(name);
  };

  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => makeEl('created'),
  };
  const winHandlers = new Map(); // window event type -> [fn]
  const windowStub = {
    addEventListener(type, fn) {
      if (!winHandlers.has(type)) winHandlers.set(type, []);
      winHandlers.get(type).push(fn);
    },
    removeEventListener() {},
  };
  // The extension host drives the settings page purely over postMessage; replay
  // one of those messages here to prove the webview actually reacts to it.
  const fireWindow = (type, data) => {
    for (const fn of winHandlers.get(type) || []) fn({ data });
  };
  const acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m), getState: () => undefined, setState() {} });

  const api = new Function(
    'document',
    'window',
    'acquireVsCodeApi',
    script + '\n;return { renderActivity, renderGrants, renderProxies, renderPxTools, renderPxToolsPending, requestPxTools, pxEditPanel, pxCountEl, onPxToolsResult, pxModalOpen, pxModalClose, togglePxEdit, savePxEdit };',
  )(document, windowStub, acquireVsCodeApi);

  // First-load handshake: the extension host must wait until this browser-side
  // listener graph exists before it publishes init/proxy frames.
  assert(posted.some((m) => m.type === 'ready'), '设置页未发送 ready 握手，首开状态可能在 listener 就绪前丢失');

  // Login is one generic entry. Once an account exists, the page keeps only
  // refresh/redeem/logout controls and does not offer a second provider button.
  fireWindow('message', { type: 'cloudAccount', view: { state: 'logged_out' } });
  assert(document.getElementById('cloudSignIn').style.display === '', '未登录时应显示唯一登录入口');
  assert(document.getElementById('cloudSignOut').style.display === 'none', '未登录时不应显示退出入口');
  fireWindow('message', { type: 'cloudAccount', view: { state: 'verified', userId: 'user-1', account: { status: 'active', serviceExpiresAt: 1800003600, serverNow: 1800000000 } } });
  assert(document.getElementById('cloudSignIn').style.display === 'none', '登录后应隐藏登录入口');
  assert(document.getElementById('cloudSignOut').style.display === '', '登录后应显示退出入口');

  // Activity nodes must survive both unchanged polls and changes to today's counters.
  const days = Array.from({length:7}, (_,i) => ({start:new Date(2026,8,10+i).getTime(),total:i,diff_added:i*2,diff_removed:i}));
  const stats = {total:6,diff_added:12,diff_removed:6};
  api.renderActivity(stats,days);
  const cells = [...document.getElementById('activityGrid').children];
  assert(cells.length === 7, 'activity needs exactly seven day cells');
  cells[3].focus();
  api.renderActivity(stats,days);
  assert(cells.every((c,i) => document.getElementById('activityGrid').children[i] === c), 'unchanged poll rebuilt activity cells');
  api.renderActivity({...stats,total:7}, days.map((d,i) => i===6?{...d,total:7}:d));
  assert(cells.every((c,i) => document.getElementById('activityGrid').children[i] === c), 'counter change rebuilt day nodes');
  assert(document.activeElement === cells[3], 'poll lost keyboard focus');
  api.renderActivity(null,[]);
  assert(document.getElementById('activityGrid').children.length === 7, 'disconnect cleared last valid activity');

  // 0) approval management renders both effective scopes. Session grants are
  // intentionally visible even though they are in-memory only.
  api.renderGrants({
    always: ['pattern:包管理变更|warn'],
    sessions: [{ session_id: 's1', session_name: 'demo', workspace_path: 'C:/repo', grants: ['path:C:/repo/build'] }],
  });
  const grantsHtml = document.getElementById('aglist').innerHTML;
  assert(grantsHtml.includes('全局授权'), '授权管理未渲染全局授权分组');
  assert(grantsHtml.includes('会话授权') && grantsHtml.includes('demo'), '授权管理未渲染会话授权分组');
  assert(grantsHtml.includes('data-scope="always"'), '全局授权删除按钮缺 scope');
  assert(grantsHtml.includes('data-scope="session"') && grantsHtml.includes('data-session="s1"'), '会话授权删除按钮缺 session scope/id');

  // 1) card rendering: 4 actions per card, panel container, disabled/config_error handling
  const info = {
    configured: true,
    daemonId: 'd1',
    status: [
      { name: 'alpha', status: 'online', tools: ['a', 'b'] },
      { name: 'beta', status: 'disabled', tools: ['x'] },
      { name: 'gamma', status: 'config_error', reason: 'boom' },
      { name: 'delta', status: 'starting', tools: [], catalogCount: null },
      { name: 'failed', status: 'crashed', reason: 'fixture failed', tools: [], catalogCount: null },
    ],
    disabled: ['beta'],
    config: [
      { name: 'alpha', transport: 'stdio', command: 'node', args: ['s.js'], merge: true, warnings: [], limits: { callTimeoutMs: 5000 }, prewarm: 'on_session_start' },
      { name: 'beta', transport: 'http', url: 'http://127.0.0.1:9/mcp', merge: true, warnings: [] },
    ],
  };
  api.renderProxies(info);
  const bodyHtml = document.getElementById('pxBody').innerHTML;
  assert(bodyHtml.includes('data-tools="alpha"'), 'alpha 缺「工具」按钮');
  assert(bodyHtml.includes('data-toggle="alpha"'), 'alpha 缺「停用/启用」按钮');
  assert(bodyHtml.includes('data-del="alpha"'), 'alpha 缺「删除」按钮');
  assert(bodyHtml.includes('data-del="beta"'), '停用的 beta 缺「删除」按钮');
  assert(!bodyHtml.includes('data-toggle="gamma"'), 'config_error 条目不该有启停按钮');
  // 工具列表走弹窗：卡片里不应再有内联面板（避免展开时重排卡片布局）
  assert(!bodyHtml.includes('data-panel='), '卡片里不应再有内联工具面板（改走弹窗）');
  assert(bodyHtml.includes('已停用'), '停用卡片缺「已停用」徽标');
  // 简洁性守护：卡片只呈现必要字段/状态，不带解释性说明文字
  assert(!bodyHtml.includes('配置与策略保留'), '卡片不应带「停用」解释性说明（应保持简洁）');
  assert(!bodyHtml.includes('不会删除'), '卡片不应带「停用≠删除」解释性说明（应保持简洁）');
  // 编辑按钮（config_error 条目没有）
  assert(bodyHtml.includes('data-edit="alpha"'), 'alpha 缺「编辑」按钮');
  assert(!bodyHtml.includes('data-edit="gamma"'), 'config_error 条目不该有「编辑」按钮');
  assert(bodyHtml.includes('data-edit-panel="alpha"'), '每张卡片都要有编辑面板容器');
  // 启用/停用 = 开关样式（不是文字按钮），开/关状态反映在 class 上
  assert(bodyHtml.includes('class="pxsw on" data-toggle="alpha"'), 'alpha 的启用开关应为「开」状态');
  assert(bodyHtml.includes('class="pxsw" data-toggle="beta"'), 'beta 的启用开关应为「关」状态');
  assert(bodyHtml.includes('title="启用并启动 MCP"'), '停用项开关应明确为启用并启动 MCP');
  assert(bodyHtml.includes('title="停用并断开 MCP"'), '启用项开关应明确为停用并断开 MCP');
  assert(!bodyHtml.includes('按需连接'), '启用语义不应再描述为按需连接');
  // 工具数量气泡就是唯一入口：不再渲染独立「工具」按钮
  assert(!/data-count="beta"/.test(bodyHtml), '停用 MCP 不应显示工具数量入口');
  assert(!/data-count="delta"/.test(bodyHtml) && bodyHtml.includes('启动中…'), '启动中的 MCP 只显示启动状态，不应显示工具数量');
  assert(!/data-count="failed"/.test(bodyHtml) && bodyHtml.includes('启动失败') && bodyHtml.includes('fixture failed'), '启动失败的 MCP 应显示原因且不显示工具数量');
  assert(/data-count="alpha"[^>]*data-tools="alpha"[^>]*>2 个工具/.test(bodyHtml), `数量气泡未成为工具入口（实际 ${(/data-count="alpha"[^>]*>([^<]*)</.exec(bodyHtml) || [])[1]}）`);
  assert(!/>工具<\/?button>/.test(bodyHtml), '不应再有独立「工具」按钮');
  assert(!bodyHtml.includes('>停用<') && !bodyHtml.includes('>启用<'), '不应再有文字式「停用/启用」按钮');
  const autoReqs = posted.filter((m) => m.type === 'proxiesTools');
  assert(autoReqs.length === 0, `打开设置不应发工具查询（实际 ${autoReqs.length}）`);
  assert(
    autoReqs.every((m) => m.refresh === false),
    '自动加载必须 refresh=false（缓存优先，不得静默启动上游）',
  );

  // 2) 弹窗：打开 → 渲染工具列表（并入宿主名 / hidden / proxy 专属 / 描述）
  const modal = document.getElementById('pxModal');
  const modalBody = document.getElementById('pxModalBody');
  api.pxModalOpen('alpha');
  assert(modal.style.display === '', 'pxModalOpen 未显示弹窗');
  assert(document.getElementById('pxModalTitle').textContent === 'alpha', '弹窗标题应为 server 名');
  api.renderPxTools({
    server: 'alpha',
    ok: true,
    result: {
      name: 'alpha',
      disabled: false,
      cachedOnly: false,
      ageMs: 4200,
      tools: [
        { name: 'echo', upstreamTool: 'echo', description: 'echoes input', callable: true, conflictSources: [] },
        { name: 'search_code', upstreamTool: 'search', description: '', callable: true, conflictSources: [] },
        { name: 'proxy_only', upstreamTool: 'proxy_only', description: 'no merge', callable: true, conflictSources: [] },
      ],
    },
  });
  const th = modalBody.innerHTML;
  assert(th.includes('工具 3'), '工具数未渲染');
  assert(th.includes('实时'), 'cachedOnly=false 应标「实时」');
  assert(th.includes('data-tool-toggle="alpha"') && th.includes('data-tool-name="echo"'), '工具列表应提供选择性屏蔽开关');
  assert(th.includes('upstream: search'), 'alias 工具应在 operator UI 展示 upstream canonical tool');
  assert(th.includes('echoes input'), '未渲染工具描述');
  assert(th.includes('data-refresh="alpha"'), '缺刷新按钮');

  // 2b) 重名标记：跨 MCP 同名的 tool 要在列表里标出来（并给出还出现在哪些 server）
  api.onPxToolsResult({
    server: 'beta',
    ok: true,
    result: { name: 'beta', disabled: false, cachedOnly: false, tools: [{ name: 'echo', upstreamTool: 'echo', description: '', callable: false, conflictSources: ['alpha', 'beta'] }] },
  });
  api.renderPxTools({
    server: 'alpha',
    ok: true,
    result: {
      name: 'alpha',
      disabled: false,
      cachedOnly: false,
      tools: [
        { name: 'echo', upstreamTool: 'echo', description: '', callable: false, conflictSources: ['alpha', 'beta'] },
        { name: 'unique_tool', upstreamTool: 'unique_tool', description: '', callable: true, conflictSources: [] },
      ],
    },
  });
  assert(modalBody.innerHTML.includes('名称冲突 · alpha, beta'), '跨 MCP 同名工具未展示冲突来源');
  assert(modalBody.innerHTML.includes('重名 1'), '弹窗头部未统计冲突数');
  const dupHits = (modalBody.innerHTML.match(/名称冲突 · /g) || []).length;
  assert(dupHits === 1, `只有冲突工具才应被标记（实际 ${dupHits} 处）`);

  // 2c) 关闭弹窗
  api.pxModalClose();
  assert(modal.style.display === 'none', 'pxModalClose 未隐藏弹窗');

  // 3) disabled/starting/failed servers have no tool-entry modal.
  api.pxModalClose();
  api.pxModalOpen('beta');
  assert(modal.style.display === 'none', '停用 MCP 不应打开工具目录');
  api.pxModalOpen('delta');
  assert(modal.style.display === 'none', '启动中的 MCP 不应打开工具目录');
  api.pxModalOpen('failed');
  assert(modal.style.display === 'none', '启动失败的 MCP 不应打开工具目录');

  // 4) pending / failure states for an online MCP refresh
  api.pxModalOpen('alpha');
  api.renderPxToolsPending({ server: 'alpha', refresh: true });
  assert(modalBody.innerHTML.includes('拉取中'), 'pending（实时）文案缺失');
  api.renderPxTools({ server: 'alpha', ok: false, detail: 'boom' });
  assert(modalBody.innerHTML.includes('boom'), '失败详情未渲染');

  // 5) click delegation: the four card actions
  const clickHandlers = (handlers.get('pxBody') || []).filter((h) => h.type === 'click');
  assert(clickHandlers.length === 1, `pxBody 应有且仅有 1 个 click 委托（实际 ${clickHandlers.length}）`);
  const click = (attrs) => {
    posted.length = 0;
    const target = {
      textContent: attrs.__text ?? '',
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
    };
    for (const h of clickHandlers) h.fn({ target });
  };
  click({ 'data-toggle': 'alpha', 'data-on': '1' });
  assert(
    posted.length === 1 && posted[0].type === 'proxiesEdit' && posted[0].server === 'alpha' && posted[0].fields.enabled === false,
    `开关从「开」点一下应发 proxiesEdit(enabled:false)，实际 ${JSON.stringify(posted)}`,
  );
  click({ 'data-toggle': 'beta', 'data-on': '0' });
  assert(posted[0]?.fields?.enabled === true, `开关从「关」点一下应发 enabled:true，实际 ${JSON.stringify(posted)}`);
  click({ 'data-del': 'alpha' });
  assert(
    posted.length === 1 && posted[0].type === 'proxiesRemove' && posted[0].server === 'alpha',
    `「删除」应发 proxiesRemove，实际 ${JSON.stringify(posted)}`,
  );
  fireWindow('message', {type:'proxiesEditResult',server:'alpha',ok:true,fields:{enabled:false}});
  fireWindow('message', {type:'proxiesEditResult',server:'beta',ok:true,fields:{enabled:true}});
  // 工具数量气泡 → 打开弹窗（已有数据时点击不发请求；弹窗不参与卡片布局）
  api.renderProxies(info);
  api.onPxToolsResult({
    server: 'alpha',
    ok: true,
    result: { name: 'alpha', disabled: false, cachedOnly: false, tools: [{ name: 'echo', upstreamTool: 'echo', description: '', callable: true, conflictSources: [] }] },
  });
  api.pxModalClose();
  click({ 'data-tools': 'alpha' });
  assert(posted.length === 0, '工具数量气泡应直接打开弹窗，已有数据时不应发请求');
  assert(modal.style.display === '', '工具数量气泡未打开弹窗');
  assert(document.getElementById('pxModalTitle').textContent === 'alpha', '弹窗标题应为 alpha');
  assert(modalBody.innerHTML.includes('echo'), '弹窗未渲染工具列表');

  // 弹窗内按钮（委托挂在 #pxModal 上）：刷新 / 关闭
  const modalHandlers = (handlers.get('pxModal') || []).filter((h) => h.type === 'click');
  assert(modalHandlers.length === 1, `pxModal 应有且仅有 1 个 click 委托（实际 ${modalHandlers.length}）`);
  const clickModal = (attrs) => {
    posted.length = 0;
    const target = { textContent: '', getAttribute: (k) => (k in attrs ? attrs[k] : null) };
    for (const h of modalHandlers) h.fn({ target });
  };
  clickModal({ 'data-refresh': 'alpha' });
  assert(
    posted.length === 1 && posted[0].type === 'proxiesTools' && posted[0].refresh === true,
    `弹窗「刷新」应发 refresh=true，实际 ${JSON.stringify(posted)}`,
  );
  clickModal({ 'data-tool-toggle': 'alpha', 'data-tool-name': 'echo' });
  assert(
    posted.length === 1 && posted[0].type === 'proxiesEdit' && posted[0].server === 'alpha' && Array.isArray(posted[0].fields?.surface?.expose) && !posted[0].fields.surface.expose.includes('echo'),
    `取消工具应通过 surface.expose 屏蔽 canonical tool，实际 ${JSON.stringify(posted)}`,
  );
  clickModal({ 'data-modal-close': '1' });
  assert(modal.style.display === 'none', '弹窗「关闭」未生效');

  // 6) empty config: pxServers must be cleared so no stale requests go out
  posted.length = 0;
  api.renderProxies({ configured: false });
  api.requestPxTools(false);
  assert(posted.length === 0, '配置清空后 requestPxTools 不应再发请求（pxServers 未清空）');

  // 7) window message bus: the extension-side 1s poll pushes proxiesToolsRefresh on
  //    daemon switch / MCP reconnect; the webview must auto re-fetch with NO manual
  //    button. This is the "landing" half of the auto-sync contract (the decision
  //    half lives in packages/vscode/src/proxySync.ts, covered by proxy-sync-unit).
  assert(winHandlers.has('message'), 'webview 未注册 window message 监听（自动刷新链路断了）');
  const msgFns = winHandlers.get('message') || [];
  assert(msgFns.length >= 1, `window message 监听数量异常（${msgFns.length}）`);

  // 7a) a plain status tick must not churn the tool lists
  posted.length = 0;
  fireWindow('message', { type: 'status', overview: {} });
  assert(posted.length === 0, `status 消息不应触发工具列表请求（实际 ${posted.length}）`);

  // Reconnect and metadata refresh are observational, including legacy live=true frames.
  api.renderProxies(info);
  posted.length = 0;
  fireWindow('message', { type: 'proxiesToolsRefresh', live: true });
  fireWindow('message', { type: 'proxiesToolsRefresh', live: false });
  fireWindow('message', { type: 'proxies', info });
  assert(posted.length === 0, 'closed tool modal must never cause upstream queries on reconnect/projection');
  api.pxModalOpen('beta');
  assert(modal.style.display === 'none' && posted.length === 0, 'disabled MCP cannot open/query tools');

  // 7e) pending / result are dispatched through the bus; the list renders only for the open modal
  api.pxModalOpen('alpha'); // 打开 alpha 的工具弹窗
  fireWindow('message', { type: 'proxiesToolsPending', server: 'alpha', refresh: true });
  assert(modalBody.innerHTML.includes('拉取中'), 'proxiesToolsPending 消息未生效');
  fireWindow('message', {
    type: 'proxiesToolsResult',
    server: 'alpha',
    ok: true,
    result: { name: 'alpha', tools: [{ name: 't', upstreamTool: 't', description: '', callable: true, conflictSources: [] }] },
  });
  assert(modalBody.innerHTML.includes('工具 1'), 'proxiesToolsResult 消息未生效（弹窗打开时应渲染）');
  assert(/^1 个工具/.test(api.pxCountEl('alpha').textContent), `数量筹码应随结果更新（实际 ${api.pxCountEl('alpha').textContent}）`);
  // 弹窗没开时结果只更新数量，不重绘列表
  api.pxModalClose();
  fireWindow('message', {
    type: 'proxiesToolsResult',
    server: 'beta',
    ok: true,
    result: { name: 'beta', tools: [{ name: 'x', upstreamTool: 'x', description: '', callable: true, conflictSources: [] }] },
  });
  assert(!modalBody.innerHTML.includes('>x<'), '弹窗关闭时不应重绘工具列表');

  // 7f) config cleared → a reconnect push must not fire stale requests
  api.renderProxies({ configured: false });
  posted.length = 0;
  fireWindow('message', { type: 'proxiesToolsRefresh', live: true });
  assert(posted.length === 0, '配置清空后重连刷新不应再发请求（pxServers 未清空）');

  // 8) 编辑：连接配置为主，高级代理设置折叠；保存/取消
  api.renderProxies(info);
  click({ 'data-edit': 'alpha' });
  const ep = api.pxEditPanel('alpha');
  assert(ep.style.display === '', '点「编辑」未展开编辑面板');
  assert(ep.innerHTML.includes('data-edit-field="transport"'), '编辑面板缺 Transport');
  assert(ep.innerHTML.includes('data-edit-field="command"'), '编辑面板缺 Command');
  assert(ep.innerHTML.includes('data-edit-field="args"') && ep.innerHTML.includes('每行一个参数'), '编辑面板缺逐行 Arguments');
  assert(ep.innerHTML.includes('高级代理设置') && ep.innerHTML.includes('pxjson'), '高级代理设置应折叠保留');
  assert(ep.innerHTML.includes('data-edit-save="alpha"'), '编辑面板缺保存按钮');
  assert(ep.__json.value.includes('"limits"'), `高级设置应预填 limits（实际 ${ep.__json.value.slice(0, 80)}）`);
  assert(ep.__fields.command.value === 'node', `Command 应预填当前连接配置，实际 ${ep.__fields.command.value}`);
  assert(ep.__fields.args.value.includes('s.js'), `Arguments 应逐行预填，实际 ${ep.__fields.args.value}`);
  // 保存：连接字段 + 高级白名单字段一起进入 proxiesEdit
  posted.length = 0;
  ep.__fields.transport.value = 'stdio';
  ep.__fields.command.value = 'node';
  ep.__fields.args.value = '-y\npackage with space';
  ep.__json.value = '{"limits":{"callTimeoutMs":5000}}';
  click({ 'data-edit-save': 'alpha' });
  assert(
    posted.length === 1 && posted[0].type === 'proxiesEdit' && posted[0].server === 'alpha'
      && posted[0].fields.command === 'node' && posted[0].fields.args.length === 2
      && posted[0].fields.args[1] === 'package with space'
      && posted[0].fields.limits.callTimeoutMs === 5000,
    `「保存」应发连接字段 + 高级白名单字段，实际 ${JSON.stringify(posted)}；表单=${ep.__msg?.textContent || '无错误'}；字段=${JSON.stringify({transport:ep.__fields?.transport?.value,command:ep.__fields?.command?.value,args:ep.__fields?.args?.value,json:ep.__json?.value})}`,
  );
  // secret/身份字段不能混入高级 JSON
  posted.length = 0;
  ep.__json.value = '{"env":{"set":{"SECRET":"evil"}}}';
  click({ 'data-edit-save': 'alpha' });
  assert(posted.length === 0, 'secret env 字段应被前端拦下，不发请求');
  // 非法 JSON 也不发请求
  posted.length = 0;
  ep.__json.value = '{oops';
  click({ 'data-edit-save': 'alpha' });
  assert(posted.length === 0, '非法 JSON 不应发请求');
  // 取消折叠
  click({ 'data-edit-cancel': 'alpha' });
  assert(ep.style.display === 'none', '「取消」未折叠编辑面板');

  return fails;
}

let idx = 0;
let checked = 0;
let failed = 0;
while ((idx = bundle.indexOf('<script nonce=', idx)) !== -1) {
  const end = bundle.indexOf('</script>', idx);
  if (end === -1) break;
  let raw = bundle.slice(idx + '<script nonce='.length, end);
  raw = raw.slice(raw.indexOf('>') + 1);
  const script = resolve(raw);
  checked += 1;
  try {
    new vm.Script(script, { filename: `embedded-webview-${checked}.js` });
  } catch (e) {
    failed += 1;
    console.error(`FAIL: embedded webview script #${checked} has a syntax error: ${e.message}`);
    console.error(e.stack || e.message);
    const m = /<anonymous>:(\d+):(\d+)/.exec(e.stack || '');
    if (!m) script.split('\n').slice(0, 12).forEach((line, i) => console.error('   ' + (i + 1) + ': ' + line.trim()));
    if (m) {
      const lines = script.split('\n');
      const ln = Number(m[1]);
      for (let i = Math.max(0, ln - 3); i < Math.min(lines.length, ln + 2); i++) {
        console.error((i + 1 === ln ? '>> ' : '   ') + (i + 1) + ': ' + (lines[i] || '').trim());
      }
    }
  }
  // The settings page script is the one carrying renderProxies: exercise it.
  if (script.includes('function renderProxies')) {
    let fails = [];
    try {
      fails = runProxiesBehavior(script);
    } catch (e) {
      fails = [`执行设置页 webview 脚本抛错：${e instanceof Error ? e.stack ?? e.message : String(e)}`];
    }
    for (const f of fails) {
      failed += 1;
      console.error(`FAIL (MCP proxies webview): ${f}`);
    }
    if (fails.length === 0) console.log('PASS: MCP proxies webview behavior (cards / count chip / switch / edit form / tool modal + duplicate marking / click delegation / message bus)');
  }
  idx = end;
}

if (checked === 0) {
  console.error('FAIL: no embedded webview scripts found (bundle layout changed?)');
  process.exit(1);
}
if (failed) {
  process.exit(1);
}
console.log(`PASS: ${checked} embedded webview script(s) are valid JS`);
