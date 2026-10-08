import type { PhoneVerification } from '../../packages/contracts/dist/connections.js';
import { withProxyFetch } from '../network/proxy-fetch.js';

export interface ProbeEntry { origin: string; key: string; proxy: string }
const unverified = (): PhoneVerification => ({ state: 'unverified', checked_at: null, reason: null });
export type ProbeResult = Pick<PhoneVerification, 'state' | 'reason'>;

/** No credentials, redirects or arbitrary paths; verifies only the phone surface. */
export async function probePhoneSurface(origin: string, proxy = '', fetcher?: typeof fetch): Promise<ProbeResult> {
  const run = async (request: typeof fetch): Promise<ProbeResult> => {
    try {
      const response = await request(origin + '/remote-api/v1/session', {
        method: 'GET', headers: { 'x-blackhole-web': '1' },
        redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(8_000),
      });
      if (response.status !== 401 || !response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel();
        return { state: 'failed', reason: 'unexpected_response' };
      }
      const reader = response.body?.getReader();
      if (!reader) return { state: 'failed', reason: 'unexpected_response' };
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) { await reader.cancel(); return { state: 'failed', reason: 'unexpected_response' }; }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const text = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(text) as { error?: unknown };
      return body.error === 'unpaired' ? { state: 'passed', reason: null } : { state: 'failed', reason: 'unexpected_response' };
    } catch (error) {
      const e = error as { name?: string; code?: string; cause?: { code?: string } };
      const code = e.cause?.code || e.code || '';
      if (e.name === 'TimeoutError' || e.name === 'AbortError') return { state: 'failed', reason: 'timeout' };
      if (/CERT|TLS|SSL/.test(code)) return { state: 'failed', reason: 'tls' };
      if (e instanceof SyntaxError) return { state: 'failed', reason: 'unexpected_response' };
      return { state: 'failed', reason: 'unreachable' };
    }
  };
  return fetcher ? run(fetcher) : withProxyFetch(proxy || undefined, run);
}

interface Row { key: string; view: PhoneVerification; pending?: Promise<PhoneVerification | null> }
/**
 * Read-only views never issue network requests. Explicit probes are deduplicated,
 * scoped to the current configured origin/revision, and expire after five minutes.
 * A late reply for a removed/reconfigured entry is discarded, not published.
 */
export class RemoteProbeRegistry {
  private rows = new Map<string, Row>();
  constructor(
    private readonly entries: () => ProbeEntry[],
    private readonly request = probePhoneSurface,
    private readonly now = Date.now,
    private readonly ttlMs = 5 * 60_000,
  ) {}
  private current(origin: string): ProbeEntry | undefined {
    const entries = this.entries();
    for (const [key, row] of this.rows) {
      if (!entries.some((e) => e.origin === key && e.key === row.key)) this.rows.delete(key);
    }
    return entries.find((entry) => entry.origin === origin);
  }
  view(origin: string): PhoneVerification {
    const entry = this.current(origin), row = this.rows.get(origin);
    if (!entry || !row || row.key !== entry.key) return unverified();
    if (!row.pending && row.view.checked_at !== null &&
      (this.now() < row.view.checked_at || this.now() - row.view.checked_at >= this.ttlMs)) return unverified();
    return { ...row.view };
  }
  probe(origin: string): Promise<PhoneVerification | null> {
    const entry = this.current(origin);
    if (!entry) return Promise.resolve(null);
    const previous = this.rows.get(origin);
    if (previous?.key === entry.key && previous.pending) return previous.pending;
    const row: Row = { key: entry.key, view: { state: 'checking', checked_at: null, reason: null } };
    this.rows.set(origin, row);
    row.pending = Promise.resolve().then(() => this.request(entry.origin, entry.proxy)).then((result) => {
      if (this.current(origin)?.key !== entry.key || this.rows.get(origin) !== row) return null;
      row.view = { ...result, checked_at: this.now() };
      return { ...row.view };
    }, () => {
      if (this.current(origin)?.key !== entry.key || this.rows.get(origin) !== row) return null;
      row.view = { state: 'failed', reason: 'unreachable', checked_at: this.now() };
      return { ...row.view };
    }).finally(() => { row.pending = undefined; });
    return row.pending;
  }
}
