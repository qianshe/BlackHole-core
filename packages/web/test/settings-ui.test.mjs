import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('../src/panel/SettingsPanel.tsx', import.meta.url), 'utf8');
const remote = readFileSync(new URL('../src/panel/RemoteSection.tsx', import.meta.url), 'utf8');
const modal = readFileSync(new URL('../src/console/SettingsModal.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/console/console.module.css', import.meta.url), 'utf8');
const shared = readFileSync(new URL('../../contracts/src/settings-navigation.ts', import.meta.url), 'utf8');
const vscode = readFileSync(new URL('../../vscode/src/sharedConfigPanel.ts', import.meta.url), 'utf8');
const nativeEntry = readFileSync(new URL('../src/settings/vscode.tsx', import.meta.url), 'utf8');
const appearance = readFileSync(new URL('../src/settings/shared.css', import.meta.url), 'utf8');
const openai = readFileSync(new URL('../src/panel/OpenAISection.tsx', import.meta.url), 'utf8');

test('connection cards are flat and ordered current → channels → connector → default', () => {
  const connection = panel.slice(panel.indexOf("{page === 'connections' &&"), panel.indexOf("{page === 'network' &&"));
  assert.doesNotMatch(connection, /<details|<summary/);
  const positions = ['set-current', 'set-channel', 'set-mcp', 'set-default-connection'].map((id) => connection.indexOf(`id="${id}"`));
  assert.ok(positions.every((value) => value >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.ok(connection.includes("field('channelProxyUrl'"));
  assert.doesNotMatch(connection, /directAccessToggle|set-lan/);
});

test('one direct switch uses canonical settings; phone pairing and devices have distinct homes', () => {
  assert.match(panel, /role="switch" className="direct-switch"/);
  assert.match(panel, /directAccessEnabled: true, directAccessUrl:/);
  assert.match(panel, /id="directPort"/);
  assert.doesNotMatch(panel, /publicDirectEnabled|directGatewayUrl|lanAccess|lanPort|lanUrl/);
  const home = panel.slice(panel.indexOf("{page === 'home' &&"), panel.indexOf("{page === 'account' &&"));
  const security = panel.slice(panel.indexOf("{page === 'security' &&"), panel.indexOf("{page === 'advanced' &&"));
  assert.match(home, /RemoteSection part="pair"/);
  assert.match(security, /RemoteSection part="devices"/);
});

test('restart affordance is tied to pending settings for the active section', () => {
  assert.ok(panel.includes(String.raw`const pending = (server?.pending_restart ?? []).filter((key) => page === 'advanced' || restartPage[key] === page);`));
  assert.ok(panel.includes('{pending.length > 0 && ('));
  assert.ok(panel.includes('className="bhp-restartbar"'));
});

test('narrow settings navigation is a dismissible drawer, not a horizontal tab strip', () => {
  assert.ok(modal.includes('id="settingsNav"'));
  assert.ok(modal.includes('aria-controls="settingsNav"'));
  assert.ok(modal.includes('aria-expanded={drawerOpen}'));
  assert.ok(modal.includes('aria-hidden={narrow && !drawerOpen}'));
  assert.ok(modal.includes('[aria-current="page"]'));
  assert.ok(modal.includes('if (narrow && drawerOpen) { closeDrawer(); return; }'));
  assert.ok(css.includes('.settingsNavOpen {'));
  assert.ok(css.includes('transform: translateX(0);'));
  assert.ok(css.includes('.settingsScrim:not([hidden])'));
  assert.ok(!css.includes('narrow screens: the section list becomes a horizontal strip'));
});

test('both live hosts use the shared page tree, navigation renderer and SVG glyph set', () => {
  assert.ok(shared.includes('export function renderSettingsNavItems('));
  assert.ok(shared.includes('export function renderSettingsIcon('));
  assert.ok(shared.includes('SETTINGS_PAGE_ICONS'));
  assert.ok(modal.includes('renderSettingsNavItems({'));
  assert.match(nativeEntry, /import \{ SettingsModal \} from '\.\.\/console\/SettingsModal'/);
  assert.ok(modal.includes('SettingsIcon name="sidebar"'));
  assert.match(vscode, /data-settings-renderer="shared-react"/);
  assert.doesNotMatch(vscode, /homeAcctSignOut|currentConnectionSec|settings-nav-icon/);
});

test('home sign-out is an accessible inline icon in the shared page, not duplicated by the native shell', () => {
  const home = panel.slice(panel.indexOf("{page === 'home' &&"), panel.indexOf("{page === 'account' &&"));
  assert.match(home, /className="ck-v home-account-row"/);
  assert.match(home, /className="home-signout" aria-label="退出登录" title="退出登录"/);
  assert.match(home, /SettingsIcon name="logout"/);
  assert.doesNotMatch(home, /btnrow[^\n]*onSignOut/);
  assert.match(nativeEntry, /<SettingsModal section=/);
});

test('shared sidebar toggles expose expanded state and pairing uses the shared scan icon', () => {
  assert.ok(modal.includes('aria-expanded={!collapsed}'));
  assert.ok(modal.includes('aria-expanded={drawerOpen}'));
  assert.ok(remote.includes('SettingsIcon name="phone-scan"'));
});

test('shared settings preserve Demo control dimensions and runtime installation layout', () => {
  assert.match(appearance, /height: 36px/);
  assert.match(appearance, /min-height: 28px; padding: 3px 11px; font-size: 11px/);
  const switches = appearance.match(/\.settings-shell \.bhp button\[role='switch'\] \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(switches, 'one semantic rule must cover Home, Direct and MCP switches');
  assert.match(switches, /width: 30px/); assert.match(switches, /height: 16px/);
  assert.match(switches, /min-height: 16px/); assert.match(switches, /padding: 0/);
  assert.match(switches, /border-radius: 999px/);
  assert.match(appearance, /account-card \{ padding: 22px; border-radius: 12px/);
  assert.match(panel, /runtime-install-row/); assert.match(openai, /runtime-install-row/);
  assert.match(appearance, /runtime-install-copy \{ flex: 1 1 220px/);
});

test('OpenAI diagnostics copy goes through the host clipboard adapter', () => {
  assert.match(openai, /import \{ copyText \} from '\.\.\/console\/common'/);
  assert.match(openai, /await copyText\(text\)/);
  assert.doesNotMatch(openai, /navigator\.clipboard/);
});


test('ordinary button sizing excludes switches, catalogue pills and icon actions', () => {
  assert.doesNotMatch(appearance, /\.settings-shell \.bhp button,\s*\.settings-shell \.bhp \.card button\s*\{/);
  assert.match(appearance, /:where\(:not\(\[role='switch'\], \.pchip, \.pxe/);
  assert.match(appearance, /button\[role='switch'\]::before[^\n]*inset: -8px -7px/);
  assert.match(appearance, /button\[role='switch'\]:disabled[^\n]*opacity: \.55/);
  assert.match(appearance, /prefers-reduced-motion/);
});

test('MCP catalogue has an explicit neutral tool pill and compact row actions', () => {
  assert.match(panel, /data-tools=\{s\.name\} aria-haspopup="dialog"/);
  const pill = appearance.match(/\.settings-shell \.bhp \.pxs button\.pchip \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(pill); assert.match(pill, /height: 28px/); assert.match(pill, /background: transparent/);
  const action = appearance.match(/\.settings-shell \.bhp button\.pxe \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(action); assert.match(action, /height: 28px/); assert.match(action, /background: transparent/);
  assert.match(appearance, /button\.pxe\.danger:hover:not\(:disabled\)/);
});


test('status indicators have a distinct decorative class, never the description class', () => {
  const home = readFileSync(new URL('../src/panel/HomeChannelCard.tsx', import.meta.url), 'utf8');
  const panelCss = readFileSync(new URL('../src/panel/panel.css', import.meta.url), 'utf8');
  for (const source of [panel, home]) {
    assert.doesNotMatch(source, /<span className="d"\s*\/>|<span className=\{\s*'d '/);
    assert.match(source, /status-dot[^\n]*aria-hidden="true"/);
  }
  assert.match(panelCss, /\.bhp \.status-dot[^\n]*flex: 0 0 6px[^\n]*margin: 0/);
  assert.match(panelCss, /\.bhp \.pxb[^\n]*align-items: center[^\n]*min-height: 20px/);
  assert.doesNotMatch(panelCss, /\.(?:pxb|agchip|ck-v)(?:\.on)? \.d(?:\s|\.)/);
  assert.match(panel, /className="status-label">\{badge\[1\]\}/);
});

test('block descriptions and inline status helpers cannot share paragraph margins', () => {
  assert.doesNotMatch(appearance, /\.settings-shell \.bhp \.d\s*\{/);
  assert.match(appearance, /\.settings-shell \.bhp div\.d[^\n]*margin-top: 4px/);
  assert.match(appearance, /:is\(\.chrow, \.btnrow\) > :is\(\.hint, \.d\) \{ margin: 0;/);
  assert.match(appearance, /\.settings-shell \.bhp \.btnrow \{ align-items: center;/);
});


test('Agent settings no longer render the redundant Web Agent display card', () => {
  const agents = panel.slice(panel.indexOf("{page === 'agents' &&"), panel.indexOf("{page === 'security' &&"));
  assert.doesNotMatch(panel, /import \{ WebAgentsSection \}/);
  assert.doesNotMatch(agents, /WebAgentsSection|Web Agent 显示/);
  assert.match(agents, /Courier 网页站点/);
  assert.doesNotMatch(panel, /webAgents: 'agents'|customWebAgents: 'agents'/);
});


test('home account places remaining time in the heading, leaving identity and logout on the value row', () => {
  const home = panel.slice(panel.indexOf("{page === 'home' &&"), panel.indexOf("{page === 'account' &&"));
  const header = home.indexOf('className="ck-head home-account-head"');
  const remaining = home.indexOf('className="ck-summary home-account-remaining" title={homeRemaining}');
  const identityRow = home.indexOf('className="ck-v home-account-row"');
  const identity = home.indexOf('className="home-account-name"');
  const logout = home.indexOf('className="home-signout"');
  assert.ok(header >= 0 && header < remaining && remaining < identityRow && identityRow < identity && identity < logout);
  assert.doesNotMatch(home.slice(identityRow, logout), /home-account-remaining/);
  assert.match(appearance, /\.bhp \.ck-head \{/);
  assert.match(appearance, /\.bhp \.ck-summary \{/);
  assert.match(appearance, /\.bhp \.ck-summary[^\n]*text-overflow: ellipsis/);
  assert.match(appearance, /home-account-remaining[^\n]*font-size: 10\.5px/);
});

test('all three cockpit cells use the same heading rhythm and activity retains today summary', () => {
  const activity = panel.slice(panel.indexOf('function Activity('), panel.indexOf('// ─── the panel'));
  const channel = readFileSync(new URL('../src/panel/HomeChannelCard.tsx', import.meta.url), 'utf8');
  assert.match(activity, /className="activity-head ck-head"/);
  assert.match(activity, /className="activity-today ck-summary"/);
  assert.match(channel, /className="ck-head"/);
});

test('shared settings owns form typography, focus and stable content width', () => {
  assert.match(appearance, /scrollbar-gutter: stable/);
  assert.match(appearance, /\.bhp textarea[^\n]*font: 13px\/1\.55/);
  assert.match(appearance, /:is\(button,input,select,textarea,summary\):focus-visible[^\n]*outline: 2px/);
  assert.match(appearance, /\.bhp select[^\n]*font: 13px\/1\.55/);
  assert.doesNotMatch(readFileSync(new URL('../src/panel/panel.css', import.meta.url), 'utf8'), /textarea:focus \{ outline: 1px|pchip\[data-tools\]:focus-visible \{ outline: 1px|#cloudPlan:focus \{ outline:1px/);
});

test('desktop section blurbs stay inline and narrow Web settings use the full viewport', () => {
  const panelCss = readFileSync(new URL('../src/panel/panel.css', import.meta.url), 'utf8');
  assert.doesNotMatch(panelCss, /\.bhp \.sec small \{ display: block/);
  assert.match(appearance, /\.sec small \{ display: inline/);
  assert.match(css, /\.overlay\[aria-label='设置'\] \{ padding: 0; \}/);
  assert.match(css, /\.overlay\[aria-label='设置'\] \.modal \{/);
});

test('destructive secondary actions share one quiet danger treatment', () => {
  assert.match(appearance, /button\.secondary\.danger-secondary/);
  assert.match(panel, /mcpRotate" className="secondary danger-secondary"/);
  assert.match(panel, /semanticClear\(\)[^\n]*secondary danger-secondary|secondary danger-secondary[^\n]*semanticClear\(\)/);
  assert.match(panel, /grantsClear\(\)[^\n]*secondary danger-secondary|secondary danger-secondary[^\n]*grantsClear\(\)/);
  assert.match(openai, /clearKey\(\)[^\n]*secondary danger-secondary|secondary danger-secondary[^\n]*clearKey\(\)/);
});


test('inline removals use compact tertiary-danger styling rather than ordinary button sizing', () => {
  const legacy = readFileSync(new URL('../src/panel/panel.css', import.meta.url), 'utf8');
  assert.match(appearance, /button:where\(:not\([^\n]*\.del/);
  assert.match(appearance, /\.bhp \.ag-row > button\.del \{[^\n]*height: 28px/);
  assert.match(appearance, /\.bhp \.ag-row > button\.del:hover:not\(:disabled\)/);
  assert.doesNotMatch(legacy, /\.bhp \.ag-row \.del \{[^\n]*background:/);
});

test('MCP card actions use one mobile two-row grid and no legacy 24px button rule', () => {
  const legacy = readFileSync(new URL('../src/panel/panel.css', import.meta.url), 'utf8');
  assert.match(appearance, /\.bhp \.pxs \.hd \{ display: grid; grid-template-columns:/);
  assert.match(appearance, /\.bhp \.pxs \.hd > \.pxbtns/);
  assert.match(panel, /className="nm" title=\{s\.name\}/);
  assert.doesNotMatch(legacy, /\.bhp \.pxbtns button \{[^\n]*height: 24px/);
  assert.doesNotMatch(legacy, /\.bhp \.f \.chrow button \{[^\n]*font-size:/);
  assert.doesNotMatch(legacy, /\.bhp \.direct-switch \{[^\n]*width: 40px/);
});


test('MCP tool-dialog refresh and editor share compact controls', () => {
  const legacy = readFileSync(new URL('../src/panel/panel.css', import.meta.url), 'utf8');
  assert.match(panel, /className="pxe" disabled=\{!!r\.disabled \|\| data\.loading\}/);
  assert.doesNotMatch(legacy, /\.bhp \.pxthr button \{[^\n]*font-size:/);
  assert.doesNotMatch(legacy, /\.bhp \.pxedit textarea \{[^\n]*font-size:/);
});

test('danger actions use host theme colors and descriptive accessible labels', () => {
  assert.match(appearance, /--settings-danger: var\(--vscode-errorForeground, #e51400\)/);
  assert.match(appearance, /--vscode-errorForeground: var\(--settings-danger\)/);
  assert.ok(panel.includes('aria-label={`删除网站 ${x.name}`}'));
  assert.ok(panel.includes('aria-label={`删除 MCP ${s.name}`}'));
  assert.ok(remote.includes('aria-label={`撤销 ${d.name} 的手机配对`}'));
});

test('clipped disclosure gets one visible focus ring, without a duplicate outline', () => {
  const legacy = readFileSync(new URL('../src/panel/panel.css', import.meta.url), 'utf8');
  assert.match(appearance, /:is\(\.connection-disclosure, \.connection-more\) > summary:focus-visible \{ outline: none; box-shadow: inset 0 0 0 2px/);
  assert.doesNotMatch(legacy, /\.connection-disclosure > summary:focus-visible/);
  assert.doesNotMatch(legacy, /\.bhp \.f input:focus-visible/);
});

test('minimal phone pairing hides routine probing and retains selected-endpoint safety', () => {
  const home = panel.slice(panel.indexOf("{page === 'home' &&"), panel.indexOf("{page === 'account' &&"));
  assert.doesNotMatch(home, /id="set-phone"/);
  assert.match(home, /className="card pair-card"/);
  assert.match(remote, /className="scan-head"/);
  assert.match(remote, /className="pair-access-row"/);
  assert.match(remote, /endpoints\.length > 1 \|\| \(!!origin && !selected\)/);
  assert.match(remote, /onConfigure\?\.\(\)/);
  assert.doesNotMatch(remote, />检测所选入口<\/button>/);
  assert.match(remote, /<details className="pair-help"/);
  assert.match(remote, /left <= 0 && \(/);
  assert.doesNotMatch(remote, />完成<\/button>/);
  assert.match(modal, /onNavigate=\{go\}/);
});

test('phone pairing only probes on explicit troubleshooting action, never on page load or QR issuance', () => {
  const poll = remote.slice(remote.indexOf('const load = useCallback('), remote.indexOf('const showQr = async'));
  const issue = remote.slice(remote.indexOf('const showQr = async'), remote.indexOf('const revoke = async'));
  assert.doesNotMatch(poll, /remoteAdmin\.probe/);
  assert.doesNotMatch(issue, /remoteAdmin\.probe/);
  assert.match(remote, /const probeSelected = async/);
  assert.match(remote, /onClick=\{\(\) => void probeSelected\(\)\}/);
});

test('home alone displays the compiled extension/build version in a quiet bottom-right footer', () => {
  const versionSource = readFileSync(new URL('../../../src/version.ts', import.meta.url), 'utf8');
  const rootManifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  const extensionManifest = JSON.parse(readFileSync(new URL('../../vscode/package.json', import.meta.url), 'utf8'));
  assert.equal(rootManifest.version, extensionManifest.version);
  assert.ok(versionSource.includes(`export const VERSION = '${rootManifest.version}'`));
  assert.match(panel, /import \{ VERSION \} from '\.\.\/\.\.\/\.\.\/\.\.\/src\/version'/);
  const home = panel.slice(panel.indexOf("{page === 'home' &&"), panel.indexOf("{page === 'account' &&"));
  assert.match(home, /<footer className="settings-home-version"[^\n]*>v\{VERSION\}<\/footer>/);
  assert.doesNotMatch(panel.slice(panel.indexOf("{page === 'account' &&")), /settings-home-version/);
  assert.match(modal, /active === 'home' \? ' settings-shell-home'/);
  assert.match(appearance, /\.settings-shell\.settings-shell-home > div\[tabindex\] \{/);
  assert.match(appearance, /\.settings-shell\.settings-shell-home \.bhp-home/);
  assert.match(appearance, /\.settings-home-version \{/);
});

test('shared settings header aligns with content and stays visible while pages scroll', () => {
  assert.match(appearance, /\.settings-shell > div\[tabindex\] \{[^\n]*padding: 0;/);
  assert.match(appearance, /\.settings-shell > div\[tabindex\] > div:first-child \{[^\n]*padding: 0 16px 0 30px;/);
  assert.match(appearance, /\.settings-shell > div\[tabindex\] > div:last-child \{[^\n]*padding: 16px 24px 60px 30px;/);
  assert.match(css, /\.settingsHead \{[\s\S]*?position: sticky;[\s\S]*?top: 0;/);
  assert.match(css, /\.settingsHead \{[\s\S]*?min-height: 64px;/);
  assert.match(appearance, /\.settings-shell > div\[tabindex\] > div:first-child \{[^\n]*background: var\(--settings-bg\)/);
  assert.doesNotMatch(appearance, /padding: 24px 24px 0 30px/);
  assert.doesNotMatch(css, /\.settingsHead \{[^}]*padding: 24px 28px 14px/);
});

test('mobile title, menu and close share one top row, not fixed at separate heights', () => {
  assert.match(appearance, /\.settings-shell > div\[tabindex\] > div:first-child \{[^\n]*min-height: 56px; padding: 0 12px 0 10px/);
  assert.doesNotMatch(appearance, /button\[aria-controls='settingsNav'\] \{ position: fixed/);
  assert.match(css, /\.settingsHead \{[\s\S]*?align-items: center;/);
  assert.match(css, /\.settingsHead \.close \{[^\n]*width: 32px; height: 32px;/);
  assert.match(modal, /aria-label="关闭设置"/);
});
