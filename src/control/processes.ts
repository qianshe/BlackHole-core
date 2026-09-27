import type { Router } from 'express';
import { z } from 'zod';
import { ProcessError } from '../process/types.js';
import { canonicalDirectory, type ProcessManager } from '../process/manager.js';

const processId = z.string().regex(/^proc_[0-9a-f-]{36}$/);
const common = {
  clientId: z.string().uuid(), daemonId: z.string().min(1).max(128).optional(),
  workspaces: z.array(z.string().min(1).max(2048)).max(16),
};
const syncSchema = z.object({ ...common,
  cursors: z.record(processId, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).refine(x => Object.keys(x).length <= 256).default({}),
  acknowledgements: z.array(z.object({ processId, state: z.enum(['pending', 'open', 'closed', 'unavailable']) }).strict()).max(256).default([]),
  reopen: processId.optional(),
}).strict();
const stopSchema = z.object({ ...common, daemonId: z.string().min(1).max(128), processId }).strict();

/** Native loopback bridge only: no command, arbitrary PID or startup endpoint. */
export function mountProcesses(app: Router, manager?: ProcessManager): void {
  app.use('/processes', (req, res, next) => {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/.test(host)
      || ['origin', 'authorization', 'cookie', 'sec-fetch-site', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'cf-connecting-ip'].some(name => req.headers[name] !== undefined)) {
      res.status(403).json({ error: 'native_loopback_required' }); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    if (!manager) { res.status(503).json({ error: 'process_unavailable' }); return; }
    next();
  });
  app.post('/processes/sync', (req, res) => {
    const parsed = syncSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'invalid_request' }); return; }
    const input = parsed.data;
    if (input.daemonId && input.daemonId !== manager!.daemonId) { res.status(409).json({ error: 'daemon_changed', daemonId: manager!.daemonId }); return; }
    try { res.json(manager!.syncView(input.clientId, input.workspaces.map(canonicalDirectory), input.cursors, input.acknowledgements, input.reopen)); }
    catch (error) { res.status(400).json({ error: error instanceof ProcessError ? error.code : 'process_unavailable' }); }
  });
  app.post('/processes/stop', async (req, res) => {
    const parsed = stopSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'invalid_request' }); return; }
    const input = parsed.data;
    if (input.daemonId !== manager!.daemonId) { res.status(409).json({ error: 'daemon_changed', daemonId: manager!.daemonId }); return; }
    try { res.json(await manager!.stopFromView(input.clientId, input.workspaces.map(canonicalDirectory), input.processId)); }
    catch (error) { res.status(404).json({ error: error instanceof ProcessError ? error.code : 'process_unavailable' }); }
  });
}
