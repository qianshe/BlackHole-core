// Phone access over the public channel (plan 6.13 R1–R3).
//
// - Always on, but only for an https public
//   address; a request must carry Host = that address.
// - A phone pairs once with a one-time code shown as a QR code on this computer
//   (128-bit, 5 minutes). Scanning only files a request: someone on this
//   computer must click 允许 within 2 minutes. The phone then holds a device credential (256-bit, HttpOnly,
//   Secure, SameSite=Strict, Path=/remote-api) bound to that origin.
// - Devices end on revoke, when phone access is turned off, on account
//   sign-out or switch, after 180 days unused, and when the public address
//   changes. A temporary (quick) channel's devices end with that tunnel.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { MachineStateRepo } from '../storage/machineState.js';

export const DEVICES_KEY = 'remote.devices.v1';
export const DEVICE_COOKIE = 'bh_dev';
export const PAIR_TTL_MS = 5 * 60_000;
export const DEVICE_IDLE_MS = 180 * 24 * 3600_000;
const MAX_DEVICES = 20;
const MAX_CODES = 4;
const TOUCH_EVERY_MS = 5 * 60_000;
/** How long a scanned code waits for 允许 on the computer. */
export const APPROVE_TTL_MS = 2 * 60_000;
const MAX_REQUESTS = 4;

/** A phone that scanned a code and waits for the computer to allow it. */
interface PairRequest {
  id: string;
  tokenHash: string;
  name: string;
  origin: string;
  kind: ChannelKind;
  userId: string | null;
  created: number;
  exp: number;
  state: 'pending' | 'approved' | 'denied';
}
export interface PairRequestView {
  id: string;
  name: string;
  created_at: string;
  expires_at: string;
}
export type ClaimResult =
  | { state: 'pending' }
  | { state: 'denied' }
  | { state: 'expired' }
  | { state: 'approved'; secret: string; device: DeviceRow };

export type ChannelKind = 'quick' | 'fixed';
export interface PublicChannel {
  origin: string;
  kind: ChannelKind;
}

export interface DeviceRow {
  id: string;
  hash: string;
  name: string;
  origin: string;
  kind: ChannelKind;
  user_id: string | null;
  created_at: number;
  last_seen_at: number;
}

export interface DeviceView {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string;
}

const hashOf = (secret: string): string => createHash('sha256').update(secret).digest('hex');
const iso = (t: number): string => new Date(t).toISOString();

/** Origin of an https URL, or null. */
export function httpsOrigin(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname ? u.origin : null;
  } catch {
    return null;
  }
}

/** A short, readable device name from the User-Agent ("iPhone Safari"). */
export function deviceName(ua: string | undefined): string {
  const s = ua ?? '';
  const device = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Macintosh/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : '设备';
  const browser = /EdgA?\//.test(s) ? 'Edge' : /MicroMessenger/.test(s) ? '微信' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /FxiOS|Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : '浏览器';
  return `${device} ${browser}`;
}

export class RemoteAccess {
  private codes = new Map<string, { exp: number; origin: string }>();
  private requests = new Map<string, PairRequest>();
  private rows: DeviceRow[];

  constructor(private readonly state: Pick<MachineStateRepo, 'get' | 'set'>) {
    this.rows = this.load();
  }

  private load(): DeviceRow[] {
    try {
      const parsed = JSON.parse(this.state.get(DEVICES_KEY) ?? '[]') as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((r): r is DeviceRow =>
        !!r && typeof r === 'object' && typeof (r as DeviceRow).id === 'string' && /^[0-9a-f]{64}$/.test(String((r as DeviceRow).hash))
        && typeof (r as DeviceRow).origin === 'string' && ((r as DeviceRow).kind === 'quick' || (r as DeviceRow).kind === 'fixed')
        && Number.isFinite((r as DeviceRow).created_at) && Number.isFinite((r as DeviceRow).last_seen_at));
    } catch {
      return [];
    }
  }

  private save(): void {
    this.state.set(DEVICES_KEY, JSON.stringify(this.rows));
  }

  /**
   * Drop devices that can no longer be used: idle for 180 days, a quick
   * channel that is gone or changed, a fixed address that changed. A fixed
   * channel that is merely stopped keeps its devices.
   */
  prune(channel: PublicChannel | null, now = Date.now()): void {
    const keep = this.rows.filter((r) => {
      if (now - r.last_seen_at > DEVICE_IDLE_MS) return false;
      if (r.kind === 'quick') return !!channel && channel.kind === 'quick' && channel.origin === r.origin;
      if (channel && channel.kind === 'fixed' && channel.origin !== r.origin) return false;
      return true;
    });
    for (const [k, c] of this.codes) if (c.exp <= now || !channel || c.origin !== channel.origin) this.codes.delete(k);
    for (const [k, r] of this.requests) if (r.exp <= now || !channel || r.origin !== channel.origin) this.requests.delete(k);
    if (keep.length !== this.rows.length) {
      this.rows = keep;
      this.save();
    }
  }

  /** New one-time pairing code for the current channel. */
  issueCode(channel: PublicChannel, now = Date.now()): { code: string; expiresAt: number } {
    this.prune(channel, now);
    while (this.codes.size >= MAX_CODES) {
      const oldest = this.codes.keys().next().value;
      if (oldest === undefined) break;
      this.codes.delete(oldest);
    }
    const code = randomBytes(16).toString('base64url');
    const expiresAt = now + PAIR_TTL_MS;
    this.codes.set(hashOf(code), { exp: expiresAt, origin: channel.origin });
    return { code, expiresAt };
  }

  /**
   * Swap a pairing code (single use) for a pending request. The phone gets no
   * access until someone on this computer allows it; `token` is what the phone
   * polls with.
   */
  requestPair(code: unknown, channel: PublicChannel, name: string, userId: string | null, now = Date.now()): { id: string; token: string; expiresAt: number } | null {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(code)) return null;
    const key = hashOf(code);
    const c = this.codes.get(key);
    if (!c) return null;
    this.codes.delete(key);
    if (c.exp <= now || c.origin !== channel.origin) return null;
    this.prune(channel, now);
    while (this.requests.size >= MAX_REQUESTS) {
      const oldest = this.requests.keys().next().value;
      if (oldest === undefined) break;
      this.requests.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const exp = now + APPROVE_TTL_MS;
    this.requests.set(id, { id, tokenHash: hashOf(token), name: name.slice(0, 60), origin: channel.origin, kind: channel.kind, userId, created: now, exp, state: 'pending' });
    return { id, token, expiresAt: exp };
  }

  /** Requests still waiting for an answer on this computer. */
  pending(channel: PublicChannel | null, now = Date.now()): PairRequestView[] {
    this.prune(channel, now);
    return [...this.requests.values()].filter((r) => r.state === 'pending').map((r) => ({ id: r.id, name: r.name, created_at: iso(r.created), expires_at: iso(r.exp) }));
  }

  /** 允许 / 拒绝 from this computer. False when the request is gone. */
  decide(id: string, allow: boolean, now = Date.now()): boolean {
    const r = this.requests.get(id);
    if (!r || r.state !== 'pending' || r.exp <= now) return false;
    r.state = allow ? 'approved' : 'denied';
    return true;
  }

  /** The phone asks whether it was allowed; an allowed request turns into a device once. */
  claim(token: unknown, channel: PublicChannel, now = Date.now()): ClaimResult {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { state: 'expired' };
    const hash = hashOf(token);
    const r = [...this.requests.values()].find((x) => x.tokenHash === hash);
    if (!r || r.origin !== channel.origin) return { state: 'expired' };
    if (r.state === 'denied') {
      this.requests.delete(r.id);
      return { state: 'denied' };
    }
    if (r.state === 'pending') {
      if (r.exp <= now) {
        this.requests.delete(r.id);
        return { state: 'expired' };
      }
      return { state: 'pending' };
    }
    this.requests.delete(r.id);
    return { state: 'approved', ...this.addDevice(channel, r.name, r.userId, now) };
  }

  private addDevice(channel: PublicChannel, name: string, userId: string | null, now: number): { secret: string; device: DeviceRow } {
    this.prune(channel, now);
    while (this.rows.length >= MAX_DEVICES) this.rows.sort((a, b) => a.last_seen_at - b.last_seen_at).shift();
    const secret = randomBytes(32).toString('base64url');
    const device: DeviceRow = { id: randomUUID(), hash: hashOf(secret), name: name.slice(0, 60), origin: channel.origin, kind: channel.kind, user_id: userId, created_at: now, last_seen_at: now };
    this.rows.push(device);
    this.save();
    return { secret, device };
  }

  /** The device holding this credential on this origin, or null. */
  check(secret: unknown, channel: PublicChannel, now = Date.now()): DeviceRow | null {
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    this.prune(channel, now);
    const hash = hashOf(secret);
    const row = this.rows.find((r) => r.hash === hash);
    if (!row || row.origin !== channel.origin) return null;
    if (now - row.last_seen_at > TOUCH_EVERY_MS) {
      row.last_seen_at = now;
      this.save();
    }
    return row;
  }

  revoke(id: string): boolean {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    if (this.rows.length === before) return false;
    this.save();
    return true;
  }

  revokeAll(): number {
    const n = this.rows.length;
    this.codes.clear();
    this.requests.clear();
    if (n) {
      this.rows = [];
      this.save();
    }
    return n;
  }

  /** Devices paired under a different account than the machine's now: gone. */
  keepAccount(userId: string): void {
    const keep = this.rows.filter((r) => r.user_id === null || r.user_id === userId);
    if (keep.length !== this.rows.length) {
      this.rows = keep;
      this.save();
    }
  }

  list(): DeviceView[] {
    return [...this.rows].sort((a, b) => b.created_at - a.created_at).map((r) => ({ id: r.id, name: r.name, created_at: iso(r.created_at), last_seen_at: iso(r.last_seen_at) }));
  }
}

/** Simple sliding-window limiter keyed by caller. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  allow(key: string, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 1000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return true;
  }
}
