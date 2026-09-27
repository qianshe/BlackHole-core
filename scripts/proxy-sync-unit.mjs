// Unit test for the v2.6 daemon-sync anchor logic (run: node scripts/proxy-sync-unit.mjs).
//
// Why: the per-MCP tool list must always belong to "the daemon actually connected
// right now", and it must auto-refresh on daemon switch / proxy surface change /
// MCP reconnect — without any manual toggle. That decision lives in
// packages/vscode/src/configPanel.ts's 1s status() poll, which the webview DOM
// stub cannot reach (it runs in the extension host). The pure decision table is
// extracted into packages/vscode/src/proxySync.ts (no vscode deps), so here we
// esbuild-transform that single file in-memory and assert the table directly.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(here, '..', 'packages', 'vscode');
const require = createRequire(path.join(pkgDir, 'package.json'));
const esbuild = require('esbuild');

const src = fs.readFileSync(path.join(pkgDir, 'src', 'proxySync.ts'), 'utf8');
const { code } = esbuild.transformSync(src, { loader: 'ts', format: 'cjs', target: 'node18' });
const mod = { exports: {} };
new Function('exports', 'module', 'require', code)(mod.exports, mod, require);
const { readAnchors, mergeAnchors, decideSyncAction } = mod.exports;

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const A = (daemonId, surfaceGen, connGen) => ({ daemonId, surfaceGen, connGen });

// 1) readAnchors: field extraction + missing / wrong-typed fields become null
check('readAnchors 抽取三枚锚点；缺失/类型不符一律 null', () => {
  assert.deepStrictEqual(
    readAnchors({ daemon_id: 'd1', proxy_surface_gen: 5, mcp_conn_gen: 3 }),
    A('d1', 5, 3),
  );
  assert.deepStrictEqual(readAnchors({}), A(null, null, null));
  assert.deepStrictEqual(
    readAnchors({ daemon_id: 42, proxy_surface_gen: '5', mcp_conn_gen: null }),
    A(null, null, null),
  );
});

// 2) first ready: anchors unknown → first sight of a daemon forces a full reload
check('首次就绪（锚点未知 → 首次见到 daemon）判定 reload', () => {
  assert.strictEqual(decideSyncAction(A(null, null, null), A('d1', 0, 1)), 'reload');
});

// 3) daemon switch wins over surface / conn changes
check('换 daemon 判定 reload（且优先于表面/连接代次变化）', () => {
  assert.strictEqual(decideSyncAction(A('d1', 5, 3), A('d2', 5, 3)), 'reload');
  assert.strictEqual(decideSyncAction(A('d1', 5, 3), A('d2', 6, 4)), 'reload');
});

// 4) surface change → repush (renderProxies re-fetches each card, cache-first)
check('表面代次变化判定 repush（且优先于连接代次）', () => {
  assert.strictEqual(decideSyncAction(A('d1', 5, 3), A('d1', 6, 3)), 'repush');
  assert.strictEqual(decideSyncAction(A('d1', 5, 3), A('d1', 6, 4)), 'repush');
});

// 5) MCP reconnect → live tool refresh, no manual trigger
check('MCP 重连（连接代次变化）判定 refresh-tools', () => {
  assert.strictEqual(decideSyncAction(A('d1', 5, 3), A('d1', 5, 4)), 'refresh-tools');
});

// 6) steady state → nothing
check('无变化判定 none', () => {
  assert.strictEqual(decideSyncAction(A('d1', 5, 3), A('d1', 5, 3)), 'none');
});

// 7) daemon unreachable: all-null payload must NOT clear anchors nor fire an action
check('daemon 不可达（全 null）不动作，且 mergeAnchors 保留旧锚点', () => {
  const prev = A('d1', 5, 3);
  const next = A(null, null, null);
  assert.strictEqual(decideSyncAction(prev, next), 'none');
  assert.deepStrictEqual(mergeAnchors(prev, next), prev);
});

// 8) recovery after unreachable must not be misjudged as "first ready"
check('不可达恢复后不误判为首次就绪（锚点未被清空）', () => {
  const prev = A('d1', 5, 3);
  const merged = mergeAnchors(prev, A(null, null, null));
  assert.strictEqual(decideSyncAction(merged, A('d1', 5, 3)), 'none');
  // 恢复时若确实变了，仍能正确判定
  assert.strictEqual(decideSyncAction(merged, A('d1', 6, 3)), 'repush');
  assert.strictEqual(decideSyncAction(merged, A('d1', 5, 9)), 'refresh-tools');
});

// 9) first sight of a generation (prev null) cannot be compared → no action
check('首次见到某代次（旧值 null）不误判为变化', () => {
  assert.strictEqual(decideSyncAction(A('d1', null, null), A('d1', 5, 3)), 'none');
  // 但 daemonId 从 null → 有值仍是"首次就绪"
  assert.strictEqual(decideSyncAction(A(null, 5, 3), A('d1', 5, 3)), 'reload');
});

// 10) mergeAnchors: non-null fields overwrite, null fields keep the old value
check('mergeAnchors 非空覆盖 / 空保留', () => {
  assert.deepStrictEqual(
    mergeAnchors(A('d1', 5, 3), A('d2', null, 9)),
    A('d2', 5, 9),
  );
});

// 11) first-open lifecycle: the settings webview must announce readiness before
// the host publishes init/proxy frames. This guards the cold-start offline race.
check('设置页首开使用 ready 握手，且 poller 在 ready 前不推状态', () => {
  const panelSrc = fs.readFileSync(path.join(pkgDir, 'src', 'configPanel.ts'), 'utf8');
  assert.match(panelSrc, /\| \{ type: 'ready' \}/);
  assert.match(panelSrc, /private webviewReady = false;/);
  assert.match(panelSrc, /if \(this\.disposed \|\| !this\.webviewReady\) return;/);
  assert.match(panelSrc, /vs\.postMessage\(\{ type: 'ready' \}\);/);
  const hostListener = panelSrc.indexOf('this.webview.webview.onDidReceiveMessage');
  const htmlAssign = panelSrc.indexOf('this.webview.webview.html = this.html()');
  assert.ok(hostListener >= 0 && htmlAssign > hostListener, 'host listener must be registered before assigning webview html');
  const browserListener = panelSrc.indexOf("window.addEventListener('message'");
  const readyPost = panelSrc.indexOf("vs.postMessage({ type: 'ready' });");
  assert.ok(browserListener >= 0 && readyPost > browserListener, 'browser must install its message listener before sending ready');
});

if (process.exitCode) {
  console.error(`\nPROXY SYNC UNIT FAIL — ${passed} passed`);
  process.exit(1);
}
console.log(`\nPROXY SYNC UNIT PASS — ${passed} checks succeeded`);
