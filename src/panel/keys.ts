import { randomInt } from 'node:crypto';
import { randomId } from '../util/token.js';

/** Top-level tool-result `_meta` key delivered to the UI, never to the model. */
export const PANEL_APP_TOKEN_META = 'blackhole/panelAppToken';

/**
 * Capability key tying an MCP-Apps panel card to a session row.
 *
 * The card iframe is fetched over the public tunnel by a host we do not
 * control (ChatGPT's sandboxed iframe), so the key itself is the bearer
 * credential — the same trust level as the machine token in the MCP URL.
 * It lives only in daemon memory: a restart invalidates every card, and the
 * first `show` call after restart re-attaches a fresh one. A
 * session holds at most one live key. Each explicit `show` starts a new panel
 * round: the previous key moves to the short-lived graveyard so an old card
 * receives a terminal 410 instead of continuing to poll the new round.
 */
export class PanelRegistry {
  private readonly byKey = new Map<string, { sessionId: string; createdAt: number; startSeq: number; appToken: string; todosChanged: boolean }>();
  private readonly keyBySession = new Map<string, string>();
  /** Dead keys still answer (410) so a live card learns its end/replacement. */
  private readonly deadKeys = new Map<string, { sessionId: string; expiresAt: number; reason: 'superseded' | 'session_terminated' | 'expired' | 'credential_rotated' | 'panel_closed' }>();
  private static readonly DEAD_KEY_TTL_MS = 15 * 60 * 1000;
  private static readonly DEAD_KEY_MAX = 256;
  private static readonly LIVE_KEY_TTL_MS = 30 * 60 * 1000;

  private pruneDeadKeys(now = Date.now()): void {
    for (const [key, entry] of this.deadKeys) {
      if (entry.expiresAt <= now) this.deadKeys.delete(key);
    }
    while (this.deadKeys.size > PanelRegistry.DEAD_KEY_MAX) {
      const oldest = this.deadKeys.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.deadKeys.delete(oldest);
    }
  }

  private rememberDead(
    key: string,
    sessionId: string,
    reason: 'superseded' | 'session_terminated' | 'expired' | 'credential_rotated' | 'panel_closed',
    now = Date.now(),
  ): void {
    this.deadKeys.set(key, { sessionId, expiresAt: now + PanelRegistry.DEAD_KEY_TTL_MS, reason });
    this.pruneDeadKeys(now);
  }

  private expireLiveKey(key: string, now = Date.now()): void {
    const entry = this.byKey.get(key);
    if (!entry || entry.createdAt + PanelRegistry.LIVE_KEY_TTL_MS > now) return;
    this.byKey.delete(key);
    if (this.keyBySession.get(entry.sessionId) === key) this.keyBySession.delete(entry.sessionId);
    this.rememberDead(key, entry.sessionId, 'expired', now);
  }

  private mint(sessionId: string, startSeq: number): string {
    const key = randomId('panel');
    this.byKey.set(key, {
      sessionId,
      createdAt: Date.now(),
      startSeq: Math.max(0, Math.trunc(startSeq)),
      todosChanged: false,
      // This token is delivered only in the UI-only tool-result `_meta` and
      // is required by the panel HTTP approval endpoint. It is deliberately
      // not the panel key: the key is model-readable for polling, while this
      // second capability is host/UI-only.
      appToken: randomId('panel-app'),
    });
    this.keyBySession.set(sessionId, key);
    return key;
  }

  /** Mint (or reuse) the key and initial call cursor for a session row id. */
  forSession(sessionId: string, startSeq = 0): string {
    this.pruneDeadKeys();
    const existing = this.keyBySession.get(sessionId);
    if (existing && this.byKey.has(existing)) return existing;
    return this.mint(sessionId, startSeq);
  }

  /**
   * Start a new user-prompt round. The previous live key is invalidated and
   * kept briefly in the graveyard so its iframe stops with an explainable 410.
   */
  mountFresh(sessionId: string, startSeq = 0): string {
    this.pruneDeadKeys();
    const previous = this.keyBySession.get(sessionId);
    if (previous) {
      const entry = this.byKey.get(previous);
      this.byKey.delete(previous);
      if (entry) {
        this.rememberDead(previous, sessionId, 'superseded');
      }
    }
    return this.mint(sessionId, startSeq);
  }

  /** The first-call cursor remains stable while the panel is mounted. */
  startSeqFor(sessionId: string): number {
    const key = this.keyBySession.get(sessionId);
    return key === undefined ? 0 : this.byKey.get(key)?.startSeq ?? 0;
  }

  /** Wall-clock time when the current panel round was mounted. */
  mountedAtFor(sessionId: string): number | undefined {
    const key = this.keyBySession.get(sessionId);
    return key === undefined ? undefined : this.byKey.get(key)?.createdAt;
  }

  /** Mark that the mounted round observed a todo-board write after it began. */
  markTodosChanged(sessionId: string): void {
    const key = this.keyBySession.get(sessionId);
    if (key === undefined) return;
    const entry = this.byKey.get(key);
    if (entry) entry.todosChanged = true;
  }

  /** Whether the current mounted round has seen a todo-board write. */
  todosChangedSinceMount(sessionId: string): boolean {
    const key = this.keyBySession.get(sessionId);
    return key === undefined ? false : this.byKey.get(key)?.todosChanged === true;
  }


  /** Resolve a key back to its session row id; undefined when unknown/expired. */
  sessionOf(key: string): string | undefined {
    this.pruneDeadKeys();
    this.expireLiveKey(key);
    return this.byKey.get(key)?.sessionId ?? this.deadKeys.get(key)?.sessionId;
  }

  /** Why a key is terminal, if it is in the short-lived graveyard. */
  terminalReason(key: string): 'superseded' | 'session_terminated' | 'expired' | 'credential_rotated' | 'panel_closed' | undefined {
    this.pruneDeadKeys();
    this.expireLiveKey(key);
    return this.deadKeys.get(key)?.reason;
  }

  /** The live key of a session, if one exists (revoke path needs it). */
  keyFor(sessionId: string): string | undefined {
    return this.keyBySession.get(sessionId);
  }

  /** UI-only capability for app-originated actions on this panel. */
  appTokenFor(sessionId: string): string | undefined {
    const key = this.keyBySession.get(sessionId);
    return key === undefined ? undefined : this.byKey.get(key)?.appToken;
  }

  /** Resolve an app action token without exposing the session id to the UI. */
  sessionForAppToken(panelKey: string, appToken: string): string | undefined {
    this.pruneDeadKeys();
    const entry = this.byKey.get(panelKey);
    return entry && entry.appToken === appToken ? entry.sessionId : undefined;
  }


  /** Close one live panel round without terminating the underlying session. */
  closeKey(key: string): boolean {
    const entry = this.byKey.get(key);
    if (!entry) return false;
    this.byKey.delete(key);
    if (this.keyBySession.get(entry.sessionId) === key) this.keyBySession.delete(entry.sessionId);
    this.rememberDead(key, entry.sessionId, 'panel_closed');
    return true;
  }
  /**
   * End a session's card. `keepAnswering` moves the key to the graveyard so a
   * card that is still mounted reads "session over" (410) on its next poll
   * instead of a bare 404 — the operator sees WHY the panel died. Without it
   * the key vanishes entirely (fresh-mint scenario).
   */
  revokeSession(
    sessionId: string,
    opts?: { keepAnswering?: boolean; reason?: 'session_terminated' | 'credential_rotated' },
  ): void {
    const key = this.keyBySession.get(sessionId);
    if (key === undefined) return;
    this.keyBySession.delete(sessionId);
    this.byKey.delete(key);
    if (opts?.keepAnswering) {
      this.rememberDead(key, sessionId, opts.reason ?? 'session_terminated');
    }
  }
}

/**
 * Operator approval PINs for the panel card's approve/deny buttons.
 *
 * Threat model: the panelKey rides on the guide result's `_meta`, which a
 * nonconforming host may expose to the model — so an agent holding the key can
 * READ /panel/<key>/data. Whatever that route returns is therefore
 * agent-visible, and can never double as an authorization factor. The second
 * factor is a short numeric PIN, minted per pending confirmation and handed
 * out ONLY over the loopback control plane (/api/confirmations response, i.e.
 * the VS Code notification / terminal the operator is already watching). The
 * public approval endpoint requires it: an agent with every public credential
 * still cannot self-answer, preserving the out-of-band promise.
 *
 * Deny needs no PIN — refusing is never a capability escalation.
 */
export class ApprovalPins {
  private readonly bySession = new Map<string, Map<string, string>>();
  private readonly missesBySession = new Map<string, Map<string, number>>();

  private mint(): string {
    return String(randomInt(100000, 1000000));
  }

  /** The PIN for a pending confirmation (minting on first sight). Loopback only. */
  pinFor(sessionId: string, confirmationId: string): string {
    let pins = this.bySession.get(sessionId);
    if (!pins) {
      pins = new Map();
      this.bySession.set(sessionId, pins);
    }
    let p = pins.get(confirmationId);
    if (p === undefined) {
      p = this.mint();
      pins.set(confirmationId, p);
    }
    return p;
  }

  /** Atomically validate and burn a session-scoped PIN at the decision point. */
  consume(sessionId: string, confirmationId: string, pin: string): boolean {
    const pins = this.bySession.get(sessionId);
    const expect = pins?.get(confirmationId);
    if (expect === undefined) return false;
    let misses = this.missesBySession.get(sessionId);
    if (!misses) {
      misses = new Map();
      this.missesBySession.set(sessionId, misses);
    }
    if (expect !== pin) {
      const n = (misses.get(confirmationId) ?? 0) + 1;
      misses.set(confirmationId, n);
      if (n >= 3) {
        pins!.set(confirmationId, this.mint());
        misses.delete(confirmationId);
      }
      return false;
    }
    pins!.delete(confirmationId);
    misses.delete(confirmationId);
    if (pins!.size === 0) this.bySession.delete(sessionId);
    if (misses.size === 0) this.missesBySession.delete(sessionId);
    return true;
  }

  /** Forget stale PIN state for one session only. */
  pruneSession(sessionId: string, pendingIds: Set<string>): void {
    const pins = this.bySession.get(sessionId);
    if (pins) {
      for (const id of pins.keys()) if (!pendingIds.has(id)) pins.delete(id);
      if (pins.size === 0) this.bySession.delete(sessionId);
    }
    const misses = this.missesBySession.get(sessionId);
    if (misses) {
      for (const id of misses.keys()) if (!pendingIds.has(id)) misses.delete(id);
      if (misses.size === 0) this.missesBySession.delete(sessionId);
    }
  }

  forget(sessionId: string, confirmationId: string): void {
    this.bySession.get(sessionId)?.delete(confirmationId);
    this.missesBySession.get(sessionId)?.delete(confirmationId);
  }
}
