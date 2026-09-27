import { workspace } from 'vscode';
import { resolveCloudEndpoint } from './cloudEnvironment';

export interface ExtConfig {
  port: number;
  daemonEntry: string;
  cloudflaredPath: string;
  /** Default tab / connection info only; never gates whether a channel may run. */
  channelMode: 'cloudflare' | 'openai' | 'custom';
  /** OpenAI tunnel-client runtime path; '' = PATH, then the managed install. */
  openaiTunnelClientPath: string;
  /** Saved OpenAI Tunnel ID (not a secret). */
  openaiTunnelId: string;
  gitUsrBinPath: string;
  publicBaseUrl: string;
  namedTunnelName: string;
  tunnelProbeProxy: string;
  pollIntervalMs: number;
  skillsDir: string;
  /** Connector name interpolated into the copied connector prompt template; '' = BlackHole. */
  connectorName: string;
  /** Semantic-search credential policy; mirrors BLACKHOLE_SEMANTIC. */
  semanticMode: 'off' | 'explicit' | 'auto';
}

export function getConfig(): ExtConfig {
  const c = workspace.getConfiguration('blackhole');
  return {
    port: c.get<number>('port') ?? 7306,
    daemonEntry: resolveCloudEndpoint().environment === 'test' ? (c.get<string>('daemonEntry') ?? '').trim() : '',
    cloudflaredPath: (c.get<string>('cloudflaredPath') ?? '').trim(),
    channelMode: c.get<string>('channelMode') === 'custom' ? 'custom' : c.get<string>('channelMode') === 'openai' ? 'openai' : 'cloudflare',
    openaiTunnelClientPath: (c.get<string>('openaiTunnelClientPath') ?? '').trim(),
    openaiTunnelId: (c.get<string>('openaiTunnelId') ?? '').trim(),
    gitUsrBinPath: (c.get<string>('gitUsrBinPath') ?? '').trim(),
    publicBaseUrl: (c.get<string>('publicBaseUrl') ?? '').trim().replace(/\/+$/, ''),
    namedTunnelName: (c.get<string>('namedTunnelName') ?? '').trim() || 'blackhole',
    tunnelProbeProxy: (c.get<string>('tunnelProbeProxy') ?? '').trim().replace(/\/+$/, ''),
    pollIntervalMs: Math.max(250, c.get<number>('pollIntervalMs') ?? 1000),
    skillsDir: (c.get<string>('skillsDir') ?? '').trim(),
    // strip a leading @ so '@MyName' and 'MyName' both render as '@MyName'
    connectorName: (c.get<string>('connectorName') ?? '').trim().replace(/^@+/, ''),
    // an unexpected value falls back to the daemon default rather than
    // silently enabling local-credential discovery
    semanticMode: ['off', 'explicit', 'auto'].includes(c.get<string>('semanticMode') ?? '')
      ? (c.get<string>('semanticMode') as 'off' | 'explicit' | 'auto')
      : 'explicit',
  };
}

export const apiBase = (port: number): string => `http://127.0.0.1:${port}/api`;
