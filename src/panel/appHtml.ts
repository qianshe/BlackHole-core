import { VERSION } from '../version.js';
import { WORKSPACE_FILE_TOOL, WORKSPACE_FILE_TOOL_HISTORY } from '../tool-routing.js';
import { PANEL_APP_TOKEN_META } from './keys.js';

/** Resource MIME that marks the document as an MCP App (host convention). */
export const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
/** ChatGPT treats the resource URI as the UI cache key. */
export const PANEL_RESOURCE_URI = 'ui://blackhole/panel.html';

/**
 * The MCP-Apps panel card, as a single self-contained HTML document.
 *
 * Rendered by Apps-capable hosts (ChatGPT) inside a sandboxed iframe: the
 * host fetches this via `resources/read` on the fixed panel URI after a
 * `show` tool result pointed at it through `_meta.ui.resourceUri`.
 * No build chain, no external assets — the whole card is this one string,
 * ~8.1 KB gzipped, in the same zero-dependency spirit as /bh.py.
 *
 * Runtime shape:
 *  - hand-written `ui/initialize` postMessage bridge (method names mirror
 *    @modelcontextprotocol/ext-apps 2.0.0; nothing else from that package is
 *    needed — zod validation and the React bindings would be dead weight)
 *  - short-lived HTTP polling against {base}/panel/{key}/data with the same
 *    epoch gate the VS Code sidebar uses: idle sessions cost an empty 204
 *  - approval buttons POST to the panel confirmation endpoint with the
 *    UI-only capability token; the blocked tool call wakes on the daemon's
 *    confirmation bus, never on a poll
 *
 * `base`/`key` are injected through tool-result messages (never spliced into JS
 * string literals) and everything agent-influenced is rendered via
 * textContent, so a hostile workspace cannot smuggle markup into the card.
 */
export function panelHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BlackHole 会话面板</title>
<style>
  :root {
    --bg: #fff; --card: #fff; --text: #202124; --muted: #6b7280; --faint: #9aa0a6;
    --border: #e5e7eb; --border-soft: #f1f3f4; --mono-bg: #f8f9fa;
    --mark: #fee2e2; --mark-text: #b91c1c;
    --blue: #2563eb; --green: #16825d; --amber: #a16207; --amber-soft: #fffbeb; --red: #c2413d;
    --shadow: none;
    font-size: 14px;
  }
  [data-theme="dark"] {
    --bg: #212121; --card: #2a2a2a; --text: #ececec; --muted: #a1a1aa; --faint: #777;
    --border: #3f3f46; --border-soft: #333338; --mono-bg: #242424;
    --mark: #4c1d1d; --mark-text: #fca5a5;
    --blue: #76a9fa; --green: #55c99a; --amber: #eab308; --amber-soft: #332b13; --red: #f87171;
    --shadow: none;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); }
  body {
    color: var(--text);
    font-family: -apple-system, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .mono { font-family: ui-monospace, "Cascadia Code", Consolas, "JetBrains Mono", monospace; }

  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    box-shadow: var(--shadow); overflow: hidden;
    height: min(460px, 100dvh); min-height: 280px;
    display: flex; flex-direction: column; flex: none;
    width: 100%; max-width: none;
    padding-bottom: 0; --sec-x: 14px;
  }
  .hdr { display: flex; align-items: center; gap: 8px; padding: 12px var(--sec-x) 10px; flex: none; }
  .ws { font-weight: 600; font-size: 12px; letter-spacing: .2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip { font-size: 10px; padding: 1px 6px; border-radius: 99px;
    border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .chip.mode { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
  .run-status { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; white-space: nowrap; }
  .uptime { font-size: 10px; line-height: 1; color: var(--muted); flex: none; font-variant-numeric: tabular-nums; }
  .live { font-size: 10px; line-height: 1; color: var(--green); display: inline-flex; align-items: center; gap: 5px; flex: none; }
  #liveTxt { line-height: 1; letter-spacing: .4px; }
  .live i { width: 6px; height: 6px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; flex: none; }
  .live.off { color: var(--red); } .live.off i { background: var(--red); animation: none; }
  .panel-close { width: 22px; height: 22px; display: grid; place-items: center; flex: none; border: 0; border-radius: 5px;
    background: transparent; color: var(--faint); cursor: pointer; font: inherit; font-size: 16px; line-height: 1; padding: 0; }
  .panel-close:hover { color: var(--text); background: var(--border-soft); }
  .panel-close:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }

  .progress-line { height: 2px; background: var(--border-soft); position: relative; flex: none; }
  .progress-line i { display: block; height: 100%; background: var(--blue); width: 0%;
    transition: width .6s cubic-bezier(.22, 1, .36, 1); position: relative; overflow: hidden; }
  .progress-line i::after {
    content: ""; position: absolute; inset: 0;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,.55), transparent);
    transform: translateX(-100%); animation: flow 2.2s infinite;
  }
  .progress-line i.done { background: var(--green); }
  .progress-line i.done::after { animation: none; opacity: 0; }

  .sec { padding: 10px var(--sec-x); border-top: 1px solid var(--border); flex: none; }
  .sec-hd { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .sec-hd .t { font-size: 11.5px; font-weight: 600; letter-spacing: .3px; }
  .sec-hd .sub { margin-left: auto; font-size: 11px; color: var(--muted); }
  .sec-hd .sub b { color: var(--blue); font-weight: 600; }
  .scope { color: var(--faint); font-size: 10px; letter-spacing: .4px; }

  .cur-row { display: flex; align-items: center; gap: 9px; cursor: pointer; padding: 2px 0; user-select: none; }
  .cur-row:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; border-radius: 6px; }
  .cur { font-size: 12px; display: flex; gap: 7px; align-items: center; min-width: 0; }
  .cur .verb:empty { display: none; }
  .cur::before { content: "●"; color: var(--blue); font-size: 9px; animation: pulse 1.6s infinite; flex: none; }
  .cur .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cur .verb { color: var(--muted); flex: none; }
  .cur.alldone::before { content: "✓"; color: var(--green); font-size: 12px; animation: none; }
  .cur.empty::before { content: "◌"; color: var(--faint); font-size: 11px; animation: none; }
  .cnt { font-size: 11px; color: var(--muted); margin-left: auto; flex: none; }
  .cnt b { color: var(--blue); font-weight: 600; }
  .cnt.done b { color: var(--green); }
  .fold { flex: none; font-size: 10.5px; color: var(--faint); background: none; border: none;
    cursor: pointer; padding: 2px 4px; border-radius: 5px; transition: transform .18s, color .15s, background .15s; }
  .fold:hover { color: var(--muted); background: var(--border-soft); }
  .cur-row[aria-expanded="true"] .fold { transform: rotate(180deg); }
  #curRow[hidden] { display: none; }
  ol.todos { margin: 6px 0 0; padding: 0 2px; list-style: none; font-size: 12px; color: var(--muted);
    max-height: 116px; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable;
    scrollbar-width: thin; padding-right: 14px; }
  ol.todos::-webkit-scrollbar { width: 8px; }
  ol.todos::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  ol.todos li { display: flex; gap: 8px; padding: 2.5px 0; align-items: center; }
  ol.todos li::before { width: 12px; text-align: center; flex: none; }
  ol.todos li.p::before { content: "◌"; color: var(--faint); }
  ol.todos li.c::before { content: "✓"; color: var(--green); }
  ol.todos li.c { text-decoration: line-through; text-decoration-color: var(--faint); color: var(--faint); }
  ol.todos li.a::before { content: "●"; color: var(--blue); font-size: 9px; }
  ol.todos li.a { color: var(--text); }
  ol.todos li.g::before { content: "◎"; color: var(--blue); }
  ol.todos li.g { color: var(--text); font-weight: 600; }

  .sec.calls { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding-top: 9px; padding-bottom: 10px; }
  .calls-win { flex: 1 1 auto; min-height: 64px; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable;
    border: 0; border-radius: 0; background: transparent; scrollbar-width: thin; padding: 0 14px 0 0; }
  .calls-win::-webkit-scrollbar { width: 8px; }
  .calls-win::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  ul.feed { margin: 0; padding: 0; list-style: none; }
  ul.feed li { display: flex; align-items: baseline; gap: 7px; padding: 5px 0; font-size: 12px;
    border-bottom: 1px solid var(--border-soft); }
  ul.feed li:last-child { border-bottom: none; }
  ul.feed li.enter { animation: enter .3s ease-out; }
  .st { width: 14px; flex: none; text-align: center; font-size: 11px; }
  .st.ok { color: var(--green); } .st.fail { color: var(--red); }
  .st.run { color: var(--blue); }
  .st.run i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--blue); animation: pulse 1.2s infinite; }
  .st.wait { color: var(--amber); }
  .t { font-weight: 600; font-size: 11px; flex: none; min-width: 96px; }
  .feed .t { min-width: 0; }
  .a { color: var(--muted); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; cursor: help; }
  .a:hover, .a:focus-visible { color: var(--text); }
  .a:focus-visible { outline: 1px solid var(--border); outline-offset: 2px; border-radius: 3px; }
  /* Match the VS Code sidebar's editor-hover tooltip: compact, theme-aware,
     monospace, scrollable, and positioned by the hovered argument row. */
  #tip { position: fixed; z-index: 30; display: none; max-width: min(520px, calc(100vw - 16px)); max-height: min(320px, 60vh); overflow: auto; padding: 6px 9px; border-radius: 4px; font-family: ui-monospace, "Cascadia Code", Consolas, "JetBrains Mono", monospace; font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: var(--text); background: var(--card); border: 1px solid var(--border); box-shadow: 0 4px 14px rgba(0,0,0,.35); pointer-events: auto; cursor: text; user-select: text; }
  #tip.show { display: block; }
  .chg { display: inline-flex; gap: 4px; flex: none; font-size: 10px; font-weight: 600; }
  .chg .add { color: var(--green); } .chg .del { color: var(--red); }
  .d { font-size: 10px; color: var(--faint); flex: none; }
  .d:empty { display: none; }
  .empty-calls { padding: 24px 8px; color: var(--faint); text-align: center; font-size: 12px; }
  li.denied .t, li.denied .a { color: var(--faint); }
  li.denied .a { text-decoration: line-through; text-decoration-color: var(--red); }
  li.waiting .t { color: var(--amber); }

  .modified-files { flex: none; display: flex; justify-content: flex-end; min-width: 0; padding: 6px var(--sec-x) 7px; border-top: 1px solid var(--border); font-size: 10.5px; }
  .modified-files[hidden] { display: none; }
  .modified-files .names { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); text-align: right; }
  .approval { flex: none; margin: 0; padding: 11px var(--sec-x) 13px; border-radius: 0;
    background: var(--amber-soft); border: 0; border-top: 1px solid var(--border); animation: none; }
  @keyframes rise { from { transform: translateY(26px); opacity: 0; } }
  .ap-hd { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; min-width: 0; }
  .ap-badge { font-size: 11.5px; font-weight: 700; color: var(--amber); flex: none; }
  .cat { font-size: 10px; padding: 1px 7px; border-radius: 99px; color: var(--amber); flex: none;
    border: 1px solid color-mix(in srgb, var(--amber) 40%, transparent); }
  .ttl { margin-left: auto; font-size: 11px; color: var(--muted); flex: none; }
  .cmd { display: block; background: var(--mono-bg); border: 1px solid var(--border-soft);
    border-radius: 7px; padding: 7px 9px; font-size: 11.5px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere; margin: 0; font-family: inherit;
    max-height: 132px; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; scrollbar-width: thin; }
  .cmd::-webkit-scrollbar { width: 8px; }
  .cmd::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  .cmd code { font-family: ui-monospace, Consolas, monospace; }
  .ap-actions { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin-top: 9px; }
  .btn { min-width: 0; font-size: 11px; padding: 6px 7px; border-radius: 7px; cursor: pointer;
    border: 1px solid var(--border); background: var(--card); color: var(--text);
    transition: filter .15s, transform .05s; }
  .btn:hover { filter: brightness(1.08); } .btn:active { transform: translateY(1px); }
  .btn:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
  .cx { font-size: 10px; padding: 2px 6px; border-radius: 6px; cursor: pointer; flex: none;
    border: 1px solid var(--border); background: transparent; color: var(--faint); }
  .cx:hover { color: var(--red, #d33); border-color: var(--red, #d33); }
  .cx:disabled { opacity: .4; cursor: default; }
  .btn:disabled { opacity: .55; cursor: wait; }
  .btn.primary { background: var(--blue); border-color: var(--blue); color: #fff; font-weight: 600; }
  .btn.danger { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); }
  .ap-resolved { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 2px 0; }
  .ap-resolved.ok { color: var(--green); } .ap-resolved.no { color: var(--red); }
  .ap-resolved .spin { width: 11px; height: 11px; border: 2px solid var(--border); border-top-color: var(--blue);
    border-radius: 50%; animation: rot .7s linear infinite; }

  .empty { font-size: 12px; color: var(--faint); padding: 2px 0; }

  .card.offline .sec, .card.offline .approval { opacity: .55; pointer-events: none; transition: opacity .3s; }
  .card.offline .live { opacity: 1; pointer-events: auto; }

  @keyframes pulse { 50% { opacity: .35; } }
  @keyframes rot { to { transform: rotate(360deg); } }
  @keyframes flow { to { transform: translateX(100%); } }
  @keyframes enter { from { transform: translateY(8px); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  .cur::before, .live i, .st.run i { animation: none; }
</style>
</head>
<body>
<section class="card" id="card" role="region" aria-label="BlackHole 会话面板" data-version="${VERSION}">
  <div class="hdr">
    <span class="ws mono" id="ws">…</span>
    <span class="chip mode" id="mode" hidden></span>
    <span class="run-status">
      <span class="live" id="live"><i></i><span id="liveTxt">进行中</span><span class="uptime mono" id="uptime">00:00</span></span>
    </span>
    <button class="panel-close" id="panelClose" type="button" aria-label="关闭面板并停止轮询" title="关闭面板并停止轮询">×</button>
  </div>
  <div class="progress-line" id="progressLine" aria-hidden="true" hidden><i id="pbar"></i></div>

  <section class="sec" id="todoSec" hidden>
    <div class="cur-row" id="curRow" role="button" tabindex="0" aria-expanded="false"
         aria-label="任务清单，点击展开或收起">
      <span class="cur empty" id="cur"><span class="txt"></span></span>
      <span class="cnt mono" id="todoCount" hidden></span>
      <button class="fold mono" id="foldBtn" aria-label="展开任务清单" hidden></button>
    </div>
    <ol class="todos" id="todos" hidden></ol>
  </section>

  <section class="sec calls">
    <div class="sec-hd"><span class="t">工具调用</span><span class="sub mono"><span class="scope">本次</span> <span id="callCount">0</span></span></div>
    <div class="calls-win" id="win">
      <div class="empty-calls" id="emptyCalls">等待本次会话的工具调用…</div>
      <ul class="feed" id="feed"></ul>
    </div>
  </section>

  <div class="approval" id="approval" hidden></div>

  <div class="modified-files" id="modifiedFiles" hidden><span class="names mono" id="modifiedFileNames"></span></div>
</section>
<div id="tip" role="tooltip" aria-hidden="true"></div>
<script>
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const card = $("#card");
  let BASE = null, KEY = null, APP_TOKEN = null;
  let callsFrom = 0;
  let terminal = false;
  function extractPayload(obj) {
    if (!obj || typeof obj !== "object") return null;
    const res = obj.result && typeof obj.result === "object" ? obj.result : obj;
    let data = res.structuredContent && typeof res.structuredContent === "object" ? res.structuredContent : null;
    if (!data && Array.isArray(res.content) && res.content[0] && typeof res.content[0].text === "string") {
      try {
        const parsed = JSON.parse(res.content[0].text);
        if (parsed && typeof parsed === "object") data = parsed;
      } catch {}
    }
    if (!data && typeof res.panel_key === "string" && typeof res.panel_base === "string") {
      data = res;
    }
    const meta = (res && res._meta) || (obj && obj._meta) || null;
    return data ? { data, meta } : null;
  }
  function adoptRouting(args, result) {
    const extracted = extractPayload(result) || extractPayload(args);
    const src = extracted ? extracted.data : (result && result.structuredContent ? result.structuredContent : args);
    const meta = extracted && extracted.meta ? extracted.meta : (result && result._meta);
    if (src && typeof src.panel_key === "string" && typeof src.panel_base === "string") {
      const nextKey = src.panel_key;
      const start = Number(src.panel_start_seq);
      const newRound = KEY !== nextKey;
      const changing = KEY !== null && newRound;
      if (newRound) {
        APP_TOKEN = null;
        tornDown = false;
        terminal = false;
        failures = 0;
        card.hidden = false;
        setOnline(true);
        startUptime(true);
        if (changing) resetRound(Number.isSafeInteger(start) && start >= 0 ? start : 0);
      }
      const appToken = meta && meta["${PANEL_APP_TOKEN_META}"];
      if (typeof appToken === "string" && appToken.length > 0) APP_TOKEN = appToken;
      BASE = src.panel_base;
      while (BASE.endsWith("/")) BASE = BASE.slice(0, -1);
      KEY = nextKey;
      if (Number.isSafeInteger(start) && start >= 0) {
        if (!changing) {
          callsFrom = Math.max(callsFrom, start);
          callsAfter = Math.max(callsAfter, callsFrom);
        }
      }
      if (typeof kick === "function") kick();
      return true;
    }
    return false;
  }

  const send = (msg) => { try { window.parent.postMessage(msg, "*"); } catch {} };
  let tornDown = false;
  function terminatePanel() {
    terminal = true;
    tornDown = true;
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
    setOnline(false);
    hideTip();
    card.hidden = true;
  }
  async function closePanel() {
    if (terminal || tornDown) return;
    const base = BASE, key = KEY, appToken = APP_TOKEN;
    terminatePanel();
    if (!base || !key || !appToken) return;
    try {
      await fetch(base + "/panel/" + key + "/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_token: appToken }),
        cache: "no-store",
        keepalive: true,
      });
    } catch {}
  }
  $("#panelClose").addEventListener("click", () => { void closePanel(); });
  const initializeId = 1;

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || typeof d !== "object") return;
    if (d.id === initializeId && d.result) {
      send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      const theme = d.result.hostContext && d.result.hostContext.theme;
      if (theme === "dark" || theme === "light") document.body.dataset.theme = theme;
    }
    if (d.method === "ui/notifications/host-context-changed") {
      const theme = d.params && d.params.theme;
      if (theme === "dark" || theme === "light") document.body.dataset.theme = theme;
    }
    if (d.method === "ui/notifications/tool-input" && d.params) {
      adoptRouting(d.params.arguments || d.params, null);
    }
    if (d.method === "ui/notifications/tool-result" && d.params) {
      adoptRouting(null, d.params);
    }
    if (d.method === "ui/resource-teardown" && d.id !== undefined) {
      terminatePanel();
      send({ jsonrpc: "2.0", id: d.id, result: {} });
    }
  });

  send({ jsonrpc: "2.0", id: initializeId, method: "ui/initialize",
    params: {
      appInfo: { name: "blackhole-panel", version: card.dataset.version },
      appCapabilities: {},
      protocolVersion: "2026-01-26",
    } });

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const MODE_LABEL = { "read-only": "read-only", "workspace-write": "workspace-write", "danger-full-access": "danger-full-access" };
  let uptimeElapsed = 0, uptimeStartedAt = null, uptimeTimer = null, uptimeReady = false;
  function renderUptime() {
    const node = $("#uptime");
    if (!uptimeReady) { node.textContent = "00:00"; node.hidden = false; return; }
    const elapsed = uptimeElapsed + (uptimeStartedAt === null ? 0 : performance.now() - uptimeStartedAt);
    const total = Math.max(0, Math.floor(elapsed / 1000));
    const seconds = String(total % 60).padStart(2, "0");
    const minutes = Math.floor(total / 60) % 60;
    node.textContent = total < 3600
      ? String(minutes).padStart(2, "0") + ":" + seconds
      : String(Math.floor(total / 3600)) + ":" + String(minutes).padStart(2, "0") + ":" + seconds;
    node.hidden = false;
  }
  function startUptime(reset) {
    if (reset) uptimeElapsed = 0;
    uptimeReady = true;
    if (uptimeStartedAt === null) uptimeStartedAt = performance.now();
    if (uptimeTimer === null) uptimeTimer = setInterval(renderUptime, 1000);
    renderUptime();
  }
  function pauseUptime() {
    if (uptimeStartedAt !== null) {
      uptimeElapsed += performance.now() - uptimeStartedAt;
      uptimeStartedAt = null;
    }
    if (uptimeTimer !== null) {
      clearInterval(uptimeTimer);
      uptimeTimer = null;
    }
    renderUptime();
  }

  function renderSession(s) {
    if (!s) return;
    $("#ws").textContent = s.workspace_name || "…";
    const m = MODE_LABEL[s.mode];
    const chip = $("#mode");
    if (m) { chip.textContent = m; chip.hidden = false; }
  }

  function renderTodos(board) {
    const items = (board && board.items) || [];
    const sec = $("#todoSec");
    const progress = $("#progressLine");
    const goal = typeof board?.contract?.goal === "string" ? board.contract.goal : "";
    if (items.length === 0 && !goal) { sec.hidden = true; progress.hidden = true; $("#todos").textContent = ""; return; }
    sec.hidden = false;
    progress.hidden = items.length === 0;
    $("#curRow").hidden = items.length === 0;
    const row = $("#curRow"), cur = $("#cur"), cnt = $("#todoCount"), fold = $("#foldBtn");
    const wasAllDone = cur.className.includes("alldone");
    const done = items.filter((t) => t.status === "completed").length;
    const active = items.find((t) => t.status === "in_progress");
    const allDone = items.length > 0 && done === items.length;
    cur.className = "cur" + (items.length === 0 ? " empty" : allDone ? " alldone" : "");
    const verb = cur.querySelector(".verb");
    if (!verb) cur.prepend(el("span", "verb", "正在"));
    if (items.length === 0) {
      cur.querySelector(".verb").textContent = "";
      cur.querySelector(".txt").textContent = "清单为空 — agent 尚未制定计划";
      cnt.hidden = true; fold.hidden = true;
    } else {
      cur.querySelector(".verb").textContent = active ? "正在" : allDone ? "" : "待处理";
      cur.querySelector(".txt").textContent = active ? (active.activeForm || active.content) : (allDone ? "清单已完成" : "等待下一步");
      cnt.hidden = false; cnt.classList.toggle("done", done === items.length);
      cnt.textContent = (active ? "进行中" : allDone ? "已完成" : "待处理") + " · " + done + "/" + items.length;
      fold.hidden = false; fold.textContent = "▾"; fold.setAttribute("aria-label", "展开任务清单");
    }
    $("#pbar").style.width = items.length ? Math.round((done / items.length) * 100) + "%" : "0%";
    $("#pbar").classList.toggle("done", items.length > 0 && done === items.length);
    const ol = $("#todos");
    if (allDone && !wasAllDone) {
      row.setAttribute("aria-expanded", "false");
      ol.hidden = true;
      fold.setAttribute("aria-label", "展开任务清单");
    }
    ol.textContent = "";
    if (goal) {
      const goalItem = el("li", "g"); goalItem.textContent = "目标：" + goal; goalItem.title = goal; ol.appendChild(goalItem);
    }
    for (const t of items) {
      const li = el("li", t.status === "completed" ? "c" : t.status === "in_progress" ? "a" : "p");
      li.textContent = t.content;
      ol.appendChild(li);
    }
    if (items.length === 0 && goal) ol.hidden = false;
  }
  $("#curRow").addEventListener("click", toggleTodos);
  $("#curRow").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleTodos(); }
  });
  function toggleTodos() {
    const row = $("#curRow");
    const open = row.getAttribute("aria-expanded") === "true";
    row.setAttribute("aria-expanded", String(!open));
    $("#todos").hidden = open;
    $("#foldBtn").setAttribute("aria-label", open ? "展开任务清单" : "收起任务清单");
  }

  const win = $("#win"), feed = $("#feed");
  let stuck = true;
  win.addEventListener("scroll", () => {
    stuck = win.scrollHeight - win.scrollTop - win.clientHeight < 28;
  });
  const STATUS = {
    started:   ["run",  "", true],
    awaiting:  ["wait", "⚑", false],
    completed: ["ok",   "✓", false],
    failed:    ["fail", "✗", false],
    denied:    ["fail", "✗", false],
    unknown:   ["fail", "?", false],
  };
  const rowById = new Map();
  const modifiedFileByCall = new Map();
  function modifiedFileFact(call) {
    if (!${JSON.stringify(WORKSPACE_FILE_TOOL_HISTORY)}.includes(call.tool)) return null;
    try {
      const a = JSON.parse(call.args_json || "{}");
      const op = a.operation && typeof a.operation === "object" && !Array.isArray(a.operation) ? a.operation : a;
      if (!["create", "str_replace", "insert", "delete"].includes(op.command) || typeof a.path !== "string" || !a.path) return null;
      const name = a.path.split(/[\\/]/).filter(Boolean).pop();
      const key = typeof a.path_key === "string" && a.path_key ? a.path_key : name;
      return name && key ? { name, key, completed: call.status === "completed" && !!call.diff } : null;
    } catch { return null; }
  }
  function renderModifiedFiles() {
    const names = [], seen = new Set();
    for (const fact of modifiedFileByCall.values()) {
      if (!fact.completed || seen.has(fact.name)) continue;
      seen.add(fact.name); names.push(fact.name);
    }
    const box = $("#modifiedFiles"), node = $("#modifiedFileNames");
    if (names.length === 0) { box.hidden = true; node.textContent = ""; node.removeAttribute("title"); return; }
    const visible = names.slice(0, 5);
    node.textContent = visible.join(",") + (names.length > visible.length ? ",+" + (names.length - visible.length) : "");
    node.title = names.join(",");
    box.hidden = false;
  }
  function resetRound(start) {
    epoch = null;
    callsFrom = start;
    callsAfter = start;
    callsUpdatedAfter = 0;
    rowById.clear();
    modifiedFileByCall.clear();
    renderModifiedFiles();
    feed.textContent = "";
    $("#emptyCalls").hidden = false;
    $("#todoSec").hidden = true;
    $("#progressLine").hidden = true;
    const todoRow = $("#curRow");
    todoRow.setAttribute("aria-expanded", "false");
    $("#cur").className = "cur empty";
    $("#foldBtn").setAttribute("aria-label", "展开任务清单");
    $("#todos").hidden = true;
    $("#todos").textContent = "";
    activeConfirm = null;
    $("#approval").textContent = "";
    $("#approval").hidden = true;
  }
  function displayValue(value) {
    if (typeof value === "string") return value.slice(0, 80);
    if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
    if (Array.isArray(value)) return "(" + value.length + " 项)";
    if (value && typeof value === "object") return "(对象)";
    return "";
  }
  function argPreview(call) {
    if (call.tool === "exec" || call.tool === "pwsh" || call.tool === "bash" || call.tool === "cmd") {
      try { return JSON.parse(call.args_json).command || "执行命令"; } catch { return "执行命令"; }
    }
    if (${JSON.stringify(WORKSPACE_FILE_TOOL_HISTORY)}.includes(call.tool)) {
      try {
        const a = JSON.parse(call.args_json);
        const op = a.operation && typeof a.operation === "object" && !Array.isArray(a.operation) ? a.operation : a;
        const range = Array.isArray(op.view_range) && op.view_range.length === 2
          ? " L" + op.view_range[0] + "-" + (op.view_range[1] === -1 ? "EOF" : op.view_range[1])
          : "";
        return (op.command || "") + " " + (a.path || "") + range;
      } catch { return ""; }
    }
    if (call.tool === "todo") {
      try {
        const a = JSON.parse(call.args_json), cmd = a.command || "";
        if (cmd === "read") return "读取任务清单";
        const items = cmd === "patch" ? a.updates : a.todos;
        const first = Array.isArray(items) && items[0] && typeof items[0].content === "string" ? items[0] : null;
        const action = cmd === "patch" ? "更新任务" : cmd === "write" ? "写入任务清单" : "任务清单";
        return action + (first ? " · " + first.content + (first.status ? " → " + first.status : "") : "");
      } catch { return "任务清单"; }
    }
    if (call.tool === "process") {
      try {
        const a = JSON.parse(call.args_json), cmd = a.command || "";
        if (cmd === "start") return "启动" + (a.name ? " " + a.name : "") + (a.script ? " · " + a.script : "");
        if (cmd === "list") return "列出后台任务";
        if (cmd === "status") return "查看 " + (a.processId || "后台任务");
        if (cmd === "stop") return (a.closeTerminal ? "停止并关闭 " : "停止 ") + (a.processId || "后台任务");
        return "后台任务";
      } catch { return "后台任务"; }
    }
    if (call.tool === "context_search") {
      try { const a = JSON.parse(call.args_json); return "语义搜索" + (a.path ? " @" + a.path : "") + (a.query ? " · " + a.query : ""); } catch { return "语义搜索"; }
    }
    if (call.tool === "guide") {
      try { const a = JSON.parse(call.args_json); return a.workflow ? "加载 " + a.workflow + " 工作流" : a.tool ? "查看 " + a.tool + " 使用说明" : "获取操作手册"; } catch { return "获取操作手册"; }
    }
    if (call.tool === "show") return "打开实时进度面板";
    if (call.tool === "skill") {
      try { const a = JSON.parse(call.args_json); return a.name ? "读取 " + a.name + (a.path ? " · " + a.path : "") : "列出技能"; } catch { return "列出技能"; }
    }
    if (call.tool === "proxy") {
      try {
        const a = JSON.parse(call.args_json);
        if (a.command === "list") return "列出可用工具";
        const target = typeof a.tool === "string" && a.tool ? a.tool : "?";
        if (a.command === "explain") return "查看 " + target;
        if (a.command === "cancel") return "取消代理调用";
        let firstArg = "";
        if (typeof a.argsJson === "string" && a.argsJson.length > 0) {
          try {
            const inner = JSON.parse(a.argsJson);
            if (inner && typeof inner === "object" && !Array.isArray(inner)) {
              const k = Object.keys(inner)[0];
              if (k !== undefined) {
                firstArg = k + "=" + displayValue(inner[k]);
              }
            }
          } catch {}
        }
        const verb = a.command === "call" ? "调用" : a.command === "explain" ? "查看" : (a.command || "调用");
        return verb + " " + target + (firstArg ? " · " + firstArg : "");
      } catch { return "代理调用"; }
    }
    return call.tool || "工具调用";
  }

  const tip = $("#tip");
  let tipAnchor = null;
  let tipTimer = null;
  let tipHideTimer = null;
  const clearTipTimer = () => { if (tipTimer !== null) { clearTimeout(tipTimer); tipTimer = null; } };
  const clearTipHideTimer = () => { if (tipHideTimer !== null) { clearTimeout(tipHideTimer); tipHideTimer = null; } };
  function hideTip() {
    clearTipTimer();
    clearTipHideTimer();
    tip.classList.remove("show");
    tip.setAttribute("aria-hidden", "true");
    tipAnchor = null;
  }
  function placeTip(anchor) {
    const r = anchor.getBoundingClientRect();
    const gap = 6;
    let left = Math.min(r.left, window.innerWidth - tip.offsetWidth - 8);
    left = Math.max(8, left);
    let top = r.bottom + gap;
    if (top + tip.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - tip.offsetHeight - gap);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }
  const truncated = (n) => n.scrollWidth > n.clientWidth + 1;
  document.addEventListener("mouseover", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (tip.contains(target)) {
      clearTipHideTimer();
      return;
    }
    const anchor = target.closest(".a");
    if (anchor && feed.contains(anchor) && truncated(anchor)) {
      if (anchor === tipAnchor) return;
      clearTipHideTimer();
      clearTipTimer();
      tipTimer = setTimeout(() => {
        tipAnchor = anchor;
        tip.textContent = anchor.textContent || "";
        tip.classList.add("show");
        tip.setAttribute("aria-hidden", "false");
        placeTip(anchor);
        tipTimer = null;
      }, 1000);
      return;
    }
    clearTipTimer();
    clearTipHideTimer();
    tipHideTimer = setTimeout(hideTip, 200);
  });
  tip.addEventListener("mouseleave", () => {
    clearTipHideTimer();
    tipHideTimer = setTimeout(hideTip, 200);
  });
  win.addEventListener("scroll", hideTip, { passive: true });
  window.addEventListener("resize", hideTip);

  function upsertCall(call) {
    const fileFact = modifiedFileFact(call);
    if (fileFact) modifiedFileByCall.set(call.id, fileFact);
    else modifiedFileByCall.delete(call.id);
    renderModifiedFiles();
    let li = rowById.get(call.id);
    if (!li) {
      li = el("li");
      li.appendChild(el("span", "st"));
      li.appendChild(el("span", "t", ${JSON.stringify(WORKSPACE_FILE_TOOL_HISTORY)}.includes(call.tool) ? ${JSON.stringify(WORKSPACE_FILE_TOOL)} : call.tool));
      li.appendChild(el("span", "chg mono"));
      const arg = el("span", "a mono");
      arg.tabIndex = 0;
      li.appendChild(arg);
      li.appendChild(el("span", "d"));
      feed.appendChild(li);
      rowById.set(call.id, li);
      li.classList.add("enter");
      setTimeout(() => li.classList.remove("enter"), 350);
      $("#emptyCalls").hidden = true;
    }
    const [cls, glyph, spinner] = STATUS[call.status] || STATUS.unknown;
    const st = li.firstChild;
    st.className = "st " + cls;
    st.textContent = glyph;
    if (spinner) st.appendChild(el("i"));
    const arg = li.querySelector(".a");
    const preview = argPreview(call);
    arg.textContent = preview;
    arg.removeAttribute("title");
    arg.setAttribute("aria-label", preview || call.tool);
    const chg = li.querySelector(".chg");
    chg.textContent = "";
    if (call.diff && (call.diff.added || call.diff.removed)) {
      if (call.diff.added) chg.appendChild(el("span", "add", "+" + call.diff.added));
      if (call.diff.removed) chg.appendChild(el("span", "del", "-" + call.diff.removed));
    }
    const d = li.querySelector(".d");
    const stateText = call.status === "started" ? "运行中"
      : call.status === "awaiting" ? "等待审批"
      : call.status === "failed" ? "失败"
      : call.status === "denied" ? "已拒绝"
      : call.status === "unknown" ? "状态未知" : "";
    d.textContent = stateText || (call.duration_ms != null ? Math.max(1, Math.round(call.duration_ms / 1000)) + "s" : "");
    st.setAttribute("aria-label", call.status === "completed" ? "已完成" : stateText || "状态未知");
    li.classList.toggle("denied", call.status === "denied");
    li.classList.toggle("waiting", call.status === "awaiting");
    // M2 取消入口：proxy 的 pending/in-flight 行带取消按钮（app token 授权）
    let cx = li.querySelector(".cx");
    if (call.tool === "proxy" && (call.status === "started" || call.status === "awaiting")) {
      if (!cx) {
        cx = el("button", "cx", "取消");
        cx.onclick = async () => {
          cx.disabled = true;
          try {
            await fetch(BASE + "/panel/" + KEY + "/calls/" + call.id + "/cancel", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ app_token: APP_TOKEN || "" }),
            });
          } catch {}
        };
        li.insertBefore(cx, d);
      }
    } else if (cx) cx.remove();
    if (stuck) win.scrollTop = win.scrollHeight;
  }

  let activeConfirm = null;
  function renderConfirmations(list, epoch) {
    const box = $("#approval");
    const pending = (list || []).filter((c) => c.status === "pending");
    if (pending.length === 0) {
      activeConfirm = null;
      box.textContent = "";
      box.hidden = true;
      return;
    }
    const c = pending.find((item) => item.id === activeConfirm) || pending[0];
    activeConfirm = c.id;
    box.textContent = "";
    const hd = el("div", "ap-hd");
    hd.appendChild(el("span", "ap-badge", "⚠ 等待审批"));
    const categories = Array.isArray(c.categories) ? c.categories : [];
    for (const cat of categories.slice(0, 3)) hd.appendChild(el("span", "cat", String(cat)));
    const ttl = el("span", "ttl mono");
    hd.appendChild(ttl);
    box.appendChild(hd);
    const cmd = el("pre", "cmd");
    let pos = 0;
    const text = c.command || "";
    for (const m of (c.matches || [])) {
      const [s, e] = m.range;
      if (s > pos) cmd.appendChild(el("code", null, text.slice(pos, s)));
      cmd.appendChild(el("mark", null, text.slice(s, e)));
      pos = e;
    }
    if (pos < text.length) cmd.appendChild(el("code", null, text.slice(pos)));
    cmd.normalize();
    box.appendChild(cmd);
    const actions = el("div", "ap-actions");
    const mk = (label, cls, body) => {
      const b = el("button", "btn" + (cls ? " " + cls : ""), label);
      b.onclick = () => act(b, c.id, body);
      actions.appendChild(b);
    };
    mk("批准一次", "primary", { action: "approve" });
    mk("本会话", null, { action: "approve", scope: "session" });
    const hasCritical = (c.matches || []).some((m) => m.level === "critical");
    if (!hasCritical) mk("始终", null, { action: "approve", scope: "always" });
    mk("拒绝", "danger", { action: "deny" });
    box.appendChild(actions);
    box.hidden = false;
    const tick = () => {
      if (activeConfirm !== c.id) return;
      const left = Math.max(0, Math.round((c.expires_at - Date.now()) / 1000));
      ttl.textContent = String(Math.floor(left / 60)).padStart(2, "0") + ":" + String(left % 60).padStart(2, "0");
      if (left > 0) setTimeout(tick, 1000);
    };
    tick();
  }
  async function act(btn, id, body) {
    for (const b of $("#approval").querySelectorAll(".btn")) b.disabled = true;
    try {
      let ok = false;
      let status = 200;
      if (BASE && KEY && (body.action === "deny" || APP_TOKEN)) {
        const r = await fetch(BASE + "/panel/" + KEY + "/confirmations/" + id + "/" + body.action, {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(body.action === "approve" && APP_TOKEN ? { app_token: APP_TOKEN } : {}),
            ...(body.scope ? { scope: body.scope } : {}),
          }),
        });
        status = r.status;
        ok = r.ok;
      } else if (body.action === "approve") {
        status = 403;
      }
      const banner = el("div", "ap-resolved " + (ok ? (body.action === "deny" ? "no" : "ok") : "no"));
      if (ok) {
        banner.appendChild(el("span", "spin"));
        banner.appendChild(el("span", body.action === "deny" ? "已拒绝 — 命令不会执行" : "已批准 — 命令执行中"));
      } else {
        const msg = status === 403
          ? "当前宿主未允许组件批准 — 请在本机 VS Code 或 CLI 审批"
          : "当前宿主不支持远程批准 — 请在本机 VS Code 或 CLI 审批";
        banner.appendChild(el("span", msg));
        for (const b of $("#approval").querySelectorAll(".btn")) b.disabled = false;
        setTimeout(() => { if (banner.parentNode) banner.remove(); }, 2600);
      }
      const box = $("#approval");
      box.textContent = "";
      box.appendChild(banner);
      setTimeout(() => { box.hidden = true; activeConfirm = null; }, 1600);
    } catch {
      setOnline(false);
    }
  }

  const POLL_ACTIVE_MS = 3000, POLL_QUIET_MS = 15000, POLL_HIDDEN_MS = 60000;
  const QUIET_AFTER_POLLS = 10;
  let epoch = null, callsAfter = 0, callsUpdatedAfter = 0;
  let online = true, polling = false, failures = 0, quietPolls = 0, pollTimer = null;
  function setOnline(v) {
    const wasOnline = online;
    online = v;
    card.classList.toggle("offline", !v);
    $("#live").classList.toggle("off", !v);
    $("#liveTxt").textContent = v ? "进行中" : "已断开";
    if (wasOnline && !v) pauseUptime();
    else if (!wasOnline && v && uptimeReady) startUptime(false);
  }
  async function poll(probe) {
    if (polling || terminal || tornDown || !BASE || !KEY) return;
    if (!online && !probe) return; // 离线后只放行探测轮询，成功一次才恢复 LIVE
    polling = true;
    try {
      const q = new URLSearchParams({ epoch: epoch ?? "", calls_from: callsFrom, calls_after: callsAfter, calls_updated_after: callsUpdatedAfter });
      const r = await fetch(BASE + "/panel/" + KEY + "/data?" + q.toString(), { cache: "no-store" });
      if (r.status === 204) {
        failures = 0;
        quietPolls += 1;
        if (!online) setOnline(true);
        return;
      }
      if (r.status === 410) {
        terminatePanel();
        return;
      }
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      failures = 0;
      quietPolls = 0;
      epoch = d.epoch;
      if (d.session) renderSession(d.session);
      if (d.todos) renderTodos(d.todos);
      if (d.calls) {
        for (const c of d.calls) upsertCall(c);
        $("#callCount").textContent = d.call_total ?? rowById.size;
        if (d.next_calls_after != null) callsAfter = Math.max(callsAfter, d.next_calls_after);
        callsUpdatedAfter = d.calls_updated_after ?? callsUpdatedAfter;
      }
      if (d.confirmations !== undefined) renderConfirmations(d.confirmations, epoch);
      if (!online) setOnline(true); // 探测成功在先，LIVE/runtime 随后恢复
    } catch {
      failures += 1;
      if (failures >= 3) setOnline(false);
    } finally {
      polling = false;
      schedulePoll();
    }
  }
  function pollDelay() {
    if (document.visibilityState === "hidden") return POLL_HIDDEN_MS;
    if (!online || failures > 0) return Math.min(POLL_HIDDEN_MS, POLL_ACTIVE_MS * Math.pow(2, Math.min(failures, 5)));
    return quietPolls >= QUIET_AFTER_POLLS ? POLL_QUIET_MS : POLL_ACTIVE_MS;
  }
  function schedulePoll(delay = pollDelay()) {
    if (terminal || tornDown) return;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { pollTimer = null; void poll(!online); }, delay);
  }
  setOnline(true);
  function kick() {
    quietPolls = 0;
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
    if (BASE && KEY) void poll(!online); else schedulePoll();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") kick();
    else schedulePoll(POLL_HIDDEN_MS);
  });
  schedulePoll(POLL_ACTIVE_MS);
})();
</script>
</body>
</html>`;
}
