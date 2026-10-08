import { randomBytes } from 'node:crypto';
import manifest from '../package.json';
import path from 'node:path';
import { commands, ConfigurationTarget, ViewColumn, Uri, env, window, workspace, type Memento, type WebviewPanel } from 'vscode';
import { settingsRouteFromLegacy, normalizeSettingsRoute } from '../../contracts/src/settings-navigation';
import { validSettingsRequest, type SettingsReply, type SettingsHostInfo } from '../../contracts/src/settings-host';
import type { ControlApi } from './controlApi';
import type { DaemonManager } from './daemonManager';
import type { Poller } from './poller';
import type { SettingsSync } from './settingsSync';
import { getConfig } from './config';
import { resolveCloudEndpoint } from './cloudEnvironment';
import { SettingsHostService } from './settingsHostService';

const escape = (s: string): string => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const pageOf = (value: unknown) => typeof value === 'string' ? settingsRouteFromLegacy(value).page : normalizeSettingsRoute(value).page;

/** Native shell only. All seven pages, CSS and dialogs come from the shared React entry. */
export class SharedConfigPanel {
  private static instance: SharedConfigPanel | undefined;
  private readonly pane: WebviewPanel;
  private readonly service: SettingsHostService;
  private disposed = false;
  private ready = false;
  private readyClient = '';
  private inflight = 0;
  private requestedPage: string;

  static open(api: ControlApi, daemon: DaemonManager, _poller: Poller, sync?: SettingsSync, state?: Memento, route?: unknown, extensionUri?: Uri): void {
    const existing = this.instance;
    if (existing && !existing.disposed) {
      existing.pane.reveal(ViewColumn.One);
      if (route !== undefined) { existing.requestedPage = pageOf(route); void existing.post({ type: 'settings:navigate', page: existing.requestedPage }); }
      return;
    }
    this.instance = new SharedConfigPanel(api, daemon, sync, state, route, extensionUri ?? Uri.file(path.dirname(path.dirname(__filename))));
  }

  constructor(api: ControlApi, daemon: DaemonManager, sync: SettingsSync | undefined, private readonly state: Memento | undefined, route: unknown, extensionUri: Uri) {
    this.requestedPage = pageOf(route ?? state?.get('blackhole.settingsLastPage.v1', 'home'));
    const assets = Uri.joinPath(extensionUri, 'dist', 'settings');
    this.pane = window.createWebviewPanel('blackholeSettings', 'BlackHole 设置', ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [assets] });
    const info = (): SettingsHostInfo => {
      const c = getConfig(), cloud = resolveCloudEndpoint();
      return { kind: 'vscode', version: manifest.version, environment: cloud.environment, cloudOrigin: cloud.origin, port: c.port, pollIntervalMs: c.pollIntervalMs, ...(cloud.environment === 'test' ? { daemonEntry: c.daemonEntry ?? '' } : {}) };
    };
    this.service = new SettingsHostService({ api, info,
      sync: async () => { if (!this.disposed) { await sync?.sync(); await sync?.flush(); } },
      saveLocal: async (values, expected) => {
        const before = info() as unknown as Record<string, unknown>;
        if (Object.keys(values).some(key => !(key in expected) || expected[key] !== before[key]) || Object.keys(expected).some(key => !(key in values))) throw Error('host_settings_changed');
        const allowed = new Set(['port', 'pollIntervalMs', ...(resolveCloudEndpoint().environment === 'test' ? ['daemonEntry'] : [])]);
        if (!Object.keys(values).length || Object.keys(values).some(k => !allowed.has(k))) throw Error('invalid_host_setting');
        if ('port' in values && (!Number.isInteger(values.port) || Number(values.port) < 1024 || Number(values.port) > 65535)) throw Error('invalid_port');
        if ('pollIntervalMs' in values && (!Number.isInteger(values.pollIntervalMs) || Number(values.pollIntervalMs) < 250 || Number(values.pollIntervalMs) > 60000)) throw Error('invalid_poll_interval');
        if ('daemonEntry' in values && (typeof values.daemonEntry !== 'string' || values.daemonEntry.length > 4096 || (values.daemonEntry && !path.isAbsolute(values.daemonEntry)))) throw Error('invalid_daemon_entry');
        const config = workspace.getConfiguration('blackhole');
        for (const [key, value] of Object.entries(values)) { if (this.disposed) return; if (config.get(key) !== value) await config.update(key, value, ConfigurationTarget.Global); }
      },
      restart: () => daemon.restart(), stop: async () => { if (!await daemon.stop()) throw Error('daemon_stop_failed'); },
      copy: async text => { await env.clipboard.writeText(text); }, open: async url => env.openExternal(Uri.parse(url, true)),
      signIn: async () => commands.executeCommand('blackhole.accountSignIn'), signOut: async () => commands.executeCommand('blackhole.accountSignOut'), close: () => this.pane.dispose(),
    });
    this.pane.onDidDispose(() => { this.disposed = true; this.service.dispose(); if (SharedConfigPanel.instance === this) SharedConfigPanel.instance = undefined; });
    this.pane.webview.onDidReceiveMessage(message => { void this.receive(message); });
    const nonce = randomBytes(18).toString('hex');
    const js = this.pane.webview.asWebviewUri(Uri.joinPath(assets, 'settings.js')).toString();
    const css = this.pane.webview.asWebviewUri(Uri.joinPath(assets, 'settings.css')).toString();
    const csp = this.pane.webview.cspSource;
    this.pane.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${escape(csp)}; style-src ${escape(csp)} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none'; font-src ${escape(csp)};"><title>BlackHole 设置</title><link rel="stylesheet" href="${escape(css)}"></head><body class="settings-native-host"><div id="root" data-settings-renderer="shared-react"></div><script nonce="${nonce}" src="${escape(js)}"></script></body></html>`;
  }

  private async post(value: unknown): Promise<void> {
    if (this.disposed) return;
    try { await this.pane.webview.postMessage(value); } catch { /* disposed webview cannot receive a late reply */ }
  }
  async receive(message: unknown): Promise<void> {
    if (this.disposed || !message || typeof message !== 'object') return;
    const m = message as Record<string, unknown>;
    if (m.type === 'settings:ready') {
      if (m.clientId !== undefined && (typeof m.clientId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(m.clientId))) return;
      const client = typeof m.clientId === 'string' ? m.clientId : '';
      if (this.ready && this.readyClient === client) return;
      this.ready = true; this.readyClient = client;
      await this.post({ type: 'settings:init', ...(client ? { clientId: client } : {}), page: this.requestedPage, collapsed: this.state?.get('blackhole.settingsNavCollapsed.v1', false) ?? false });
      return;
    }
    // A reloaded webview has a different document identity. Ignore late messages
    // from the old document, without cancelling operations already accepted.
    if (!this.ready || (this.readyClient && m.clientId !== this.readyClient)) return;
    if (m.type === 'settings:state') {
      if (typeof m.page !== 'string' || typeof m.collapsed !== 'boolean') return;
      this.requestedPage = pageOf(m.page);
      await this.state?.update('blackhole.settingsLastPage.v1', this.requestedPage);
      await this.state?.update('blackhole.settingsNavCollapsed.v1', m.collapsed);
      return;
    }
    if (m.type !== 'settings:request') return;
    if (!validSettingsRequest(m.request)) {
      const id = (m.request as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id)) await this.post({ type: 'settings:reply', reply: { id, ok: false, error: { status: 400, code: 'settings_request_rejected' } } });
      return;
    }
    const request = m.request;
    if (this.inflight >= 64) { await this.post({ type: 'settings:reply', reply: { id: request.id, ok: false, error: { status: 429, code: 'settings_busy' } } }); return; }
    this.inflight++;
    let reply: SettingsReply;
    try { reply = { id: request.id, ok: true, value: await this.service.request(request) }; }
    catch (e) { const error = e as Error & { status?: number }; reply = { id: request.id, ok: false, error: { status: error.status ?? 500, code: error.message || 'settings_request_failed' } }; }
    finally { this.inflight--; }
    await this.post({ type: 'settings:reply', reply });
  }
}
