import { createHash, createPublicKey, verify } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { LifecycleTokenClaimsSchema } from '../../packages/contracts/dist/core-runtime.js';
import type { RuntimeIdentity } from '../deps.js';

/** Shared by every HTTP ingress. The final idle check and admission closure
 * are synchronous on the daemon event loop; no await permits new work between them. */
export class MaintenanceGate {
  private handlers = 0;
  private readonly wrapped = new WeakMap<Function, Function>();
  private isControl(req: Request): boolean {
    const route = (req.originalUrl || req.url || req.path).split('?', 1)[0];
    return (req.method === 'GET' && route === '/api/health') || (req.method === 'POST' && route === '/api/core/stop');
  }
  /** Track returned handler promises independently of response close. Nested
   * routers are walked at registration; no Express private method is replaced. */
  trackHandler(handler: Function): Function {
    if (this.wrapped.has(handler)) return this.wrapped.get(handler)!;
    const walk = (stack: any[]) => {
      for (const layer of stack) {
        if (Array.isArray(layer.route?.stack)) walk(layer.route.stack);
        else if (Array.isArray(layer.handle?.stack)) walk(layer.handle.stack);
        else if (typeof layer.handle === 'function') layer.handle = this.trackHandler(layer.handle);
      }
    };
    if (Array.isArray((handler as any).stack)) { walk((handler as any).stack); return handler; }
    if (handler.length === 4) return handler; // Express error middleware is not a new admission.
    const gate = this;
    const tracked = function(this: unknown, req: Request, res: Response, next: NextFunction): unknown {
      if (gate.isControl(req)) return handler.call(this, req, res, next);
      if (!gate.accepting) { res.status(503).json({ error: 'managed_core_stopping' }); return; }
      gate.handlers++;
      let done = false;
      const finish = () => { if (!done) { done = true; gate.handlers--; } };
      try {
        const result = handler.call(this, req, res, next);
        if (result && typeof result.then === 'function') return Promise.resolve(result).then(value => { finish(); return value; }, error => { finish(); throw error; });
        finish(); return result;
      } catch (error) { finish(); throw error; }
    };
    this.wrapped.set(handler, tracked); this.wrapped.set(tracked, tracked);
    return tracked;
  }
  install(app: import('express').Express): void {
    const wrap = (arg: any): any => Array.isArray(arg) ? arg.map(wrap) : typeof arg === 'function' ? this.trackHandler(arg) : arg;
    for (const method of ['use', 'all', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const) {
      const original = app[method] as Function;
      (app as any)[method] = function(this: unknown, ...args: any[]) { return original.apply(this, args.map(wrap)); };
    }
  }
  private requests = 0;
  private readonly requestCompletions = new WeakMap<Response, () => void>();
  private readonly reconnectableResponses = new Set<Response>();
  private closed = false;
  /** Only an authenticated route may mark a passive notification stream.
   * Path matching cannot grant this exemption. Async handlers remain counted
   * independently, and ordinary idle shutdown still checks page presence. */
  markReconnectableResponse(res: Response): void {
    if (this.closed) throw new Error('managed_core_stopping');
    const finish = this.requestCompletions.get(res);
    if (!finish) throw new Error('untracked_passive_response');
    finish();
    if (this.reconnectableResponses.has(res)) return;
    this.reconnectableResponses.add(res);
    const remove = () => { this.reconnectableResponses.delete(res); };
    res.once('close', remove);
    res.once('finish', remove);
  }
  get accepting(): boolean { return !this.closed; }
  get pendingRequests(): number { return this.requests; }
  middleware = (req: Request, res: Response, next: NextFunction): void => {
    const path = req.path;
    const control = (req.method === 'POST' && path === '/api/core/stop') || (req.method === 'GET' && path === '/api/health');
    if (this.closed && !control) { res.status(503).json({ error: 'managed_core_stopping' }); return; }
    if (control) { next(); return; }
    this.requests++;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; this.requests--; } };
    this.requestCompletions.set(res, finish);
    res.once('finish', finish); res.once('close', finish);
    next();
  };
  seal(assertIdle: () => void): void {
    if (this.closed) throw new Error('managed_core_stopping');
    assertIdle();
    if (this.requests !== 0) throw new Error('active_requests');
    if (this.handlers !== 0) throw new Error('active_handlers');
    this.closed = true;
    // Admission is already closed: reconnect attempts cannot enter the old
    // instance while its authenticated presence streams are being ended.
    for (const res of this.reconnectableResponses) {
      try { res.end(); } catch { /* Normal server shutdown closes the socket. */ }
    }
    this.reconnectableResponses.clear();
  }
}

export class ManagedControl {
  private readonly publicKey;
  readonly publicKeyHash: string;
  private readonly used = new Map<string, number>();
  constructor(private readonly options: {
    publicKeyPem: string; identity: RuntimeIdentity; daemonId: string; startFingerprint: string;
    gate: MaintenanceGate; assertIdle: () => void; assertUpgradeable?: () => void; now?: () => number; settingsRevision?: () => number;
  }) {
    if (Buffer.byteLength(options.publicKeyPem) > 4096 || !options.startFingerprint) throw new Error('manager_public_key_invalid');
    this.publicKey = createPublicKey(options.publicKeyPem);
    if (this.publicKey.asymmetricKeyType !== 'ed25519') throw new Error('manager_public_key_invalid');
    this.publicKeyHash = createHash('sha256').update(options.publicKeyPem).digest('hex');
  }
  acceptStop(token: unknown): { transactionId: string; daemonId: string; state: 'stopping' } {
    if (typeof token !== 'string' || token.length > 8192) throw new Error('lifecycle_token_invalid');
    const parts = token.split('.');
    if (parts.length !== 2 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error('lifecycle_token_invalid');
    const [payload, signature] = parts as [string, string];
    if (!verify(null, Buffer.from(payload), this.publicKey, Buffer.from(signature, 'base64url'))) throw new Error('lifecycle_token_signature_invalid');
    let raw: unknown;
    try { raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new Error('lifecycle_token_invalid'); }
    const claims = LifecycleTokenClaimsSchema.parse(raw);
    const now = (this.options.now ?? Date.now)();
    const issued = Date.parse(claims.issuedAt), expires = Date.parse(claims.expiresAt);
    if (expires <= now || issued > now + 2000 || expires - issued > 30_000) throw new Error('lifecycle_token_expired');
    const { identity, daemonId, startFingerprint, gate } = this.options;
    if (!['stop', 'restart', 'upgrade'].includes(claims.operation) || claims.daemonId !== daemonId || claims.startFingerprint !== startFingerprint
      || claims.runtimeId !== identity.runtimeId || claims.buildId !== identity.buildId || claims.dataRootId !== identity.dataRootId
      || claims.descriptorHash !== identity.descriptorHash) throw new Error('lifecycle_token_target_mismatch');
    if (claims.settingsRevision !== undefined && (claims.operation !== 'restart' || this.options.settingsRevision?.() !== claims.settingsRevision)) throw new Error('settings_revision_conflict');
    for (const [nonce, until] of this.used) if (until <= now) this.used.delete(nonce);
    if (this.used.has(claims.nonce)) throw new Error('lifecycle_token_replayed');
    if (this.used.size >= 4096) throw new Error('lifecycle_token_capacity');
    this.used.set(claims.nonce, expires);
    if (claims.operation === 'upgrade' && !this.options.assertUpgradeable) throw new Error('core_update_required');
    gate.seal(claims.operation === 'upgrade' ? this.options.assertUpgradeable! : this.options.assertIdle);
    identity.lifecycleState = 'stopping';
    return { transactionId: claims.transactionId, daemonId, state: 'stopping' };
  }
}
