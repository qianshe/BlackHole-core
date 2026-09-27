import { createHash, randomBytes } from 'node:crypto';
import type { MachineStateRepo } from '../storage/machineState.js';

/** 30 days, renewed while in use (sliding). */
export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_WEB_SESSIONS = 32;
/** Renewal is written at most this often per session, so reads stay read-only. */
const SLIDE_EVERY_MS = 60 * 60_000;
const ROWS_KEY = 'web.sessions.v1';
const CSRF_KEY = 'web.csrf_key.v1';

interface Row {
  /** sha256 of the cookie value; the raw value is never stored. */
  h: string;
  exp: number;
  seen: number;
  /** Cloud account the session belongs to; null = issued while this machine had no account. */
  user: string | null;
}

export type WebSessionCheck =
  | { ok: true; expiresAt: number }
  /** unauthenticated: no such session. account_required: this machine's login lapsed; the same account restores it. */
  | { ok: false; error: 'unauthenticated' | 'account_required' };

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Local Web login sessions, persisted so a daemon restart keeps everyone signed
 * in. Each session is tied to the cloud account that was signed in on this
 * machine: a lapsed login pauses it, a different account ends every session.
 * Without a state repo (tests) it lives in memory only.
 */
export class WebSessionStore {
  private rows: Row[];
  private readonly key: Buffer;

  constructor(private readonly state?: Pick<MachineStateRepo, 'get' | 'set'>, private readonly ttlMs = WEB_SESSION_TTL_MS) {
    this.rows = this.load();
    const stored = state?.get(CSRF_KEY);
    if (stored && /^[0-9a-f]{64}$/.test(stored)) this.key = Buffer.from(stored, 'hex');
    else {
      this.key = randomBytes(32);
      state?.set(CSRF_KEY, this.key.toString('hex'));
    }
  }

  /** Per-machine HMAC key for CSRF tokens; stable across restarts like the sessions it protects. */
  get csrfKey(): Buffer {
    return this.key;
  }

  private load(): Row[] {
    try {
      const raw = JSON.parse(this.state?.get(ROWS_KEY) ?? '[]') as unknown;
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((r): r is Row => !!r && typeof r.h === 'string' && /^[0-9a-f]{64}$/.test(r.h) && Number.isFinite(r.exp) && Number.isFinite(r.seen)
          && (r.user === null || (typeof r.user === 'string' && r.user.length <= 128)))
        .slice(-MAX_WEB_SESSIONS);
    } catch {
      return [];
    }
  }

  private save(): void {
    this.state?.set(ROWS_KEY, JSON.stringify(this.rows));
  }

  private sweep(now: number): boolean {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.exp > now);
    return this.rows.length !== before;
  }

  issue(user: string | null, now = Date.now()): { secret: string; expiresAt: number } {
    this.sweep(now);
    while (this.rows.length >= MAX_WEB_SESSIONS) this.rows.shift();
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = now + this.ttlMs;
    this.rows.push({ h: hash(secret), exp: expiresAt, seen: now, user });
    this.save();
    return { secret, expiresAt };
  }

  /** `user` is the account signed in on this machine right now (null = none or lapsed). */
  check(secret: unknown, user: string | null, now = Date.now()): WebSessionCheck {
    if (typeof secret !== 'string' || !SECRET_RE.test(secret)) return { ok: false, error: 'unauthenticated' };
    let dirty = this.sweep(now);
    const h = hash(secret);
    const row = this.rows.find((r) => r.h === h);
    let result: WebSessionCheck;
    if (!row) result = { ok: false, error: 'unauthenticated' };
    else if (row.user !== null && user !== null && row.user !== user) {
      // A different account took over this machine: nobody from before stays in.
      this.rows = [];
      dirty = true;
      result = { ok: false, error: 'unauthenticated' };
    } else if (row.user !== null && user === null) {
      result = { ok: false, error: 'account_required' };
    } else {
      if (row.user === null && user !== null) {
        row.user = user;
        dirty = true;
      }
      if (now - row.seen >= SLIDE_EVERY_MS) {
        row.seen = now;
        row.exp = now + this.ttlMs;
        dirty = true;
      }
      result = { ok: true, expiresAt: row.exp };
    }
    if (dirty) this.save();
    return result;
  }

  revoke(secret: unknown): void {
    if (typeof secret !== 'string') return;
    const h = hash(secret);
    const n = this.rows.length;
    this.rows = this.rows.filter((r) => r.h !== h);
    if (this.rows.length !== n) this.save();
  }

  /** Sign-out or account switch: every browser has to sign in again. */
  revokeAll(): void {
    this.rows = [];
    this.save();
  }

  get size(): number {
    return this.rows.length;
  }
}
