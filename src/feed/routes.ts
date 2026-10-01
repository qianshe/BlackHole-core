import type { Request, Response, Router } from 'express';
import type { DaemonDeps } from '../deps.js';
import { MAX_WAIT_SECONDS, type WaitResult } from '../storage/feedLog.js';
import { clampLimit, hasData, pageTimeline, readFeed, type CallRow } from './query.js';
import { parseKey } from './timeline.js';

/**
 * `GET /sessions/:id/feed`（增量 + 长轮询）与 `GET /sessions/:id/history`（往上翻页）。
 * Web 控制台、手机（local-web 的 data 路由）和 VS Code（control API）共用这一份处理函数，
 * 差别只在「一条调用怎么输出」（`mapCall`）：VS Code 原样返回行，Web/手机经 projectArgs 投影。
 */

/** 被唤醒后先等一小段再查：流式回复一秒可能更新十几次，合并成一次响应。 */
export const COALESCE_MS = 200;
/** 降级为短轮询，或等待被 daemon 关闭提前结束时，客户端下次请求前至少要等的毫秒数。 */
export const RETRY_DEGRADED_MS = 2500;
/** 手机通道有数据返回时的最小请求间隔：压低流式期间的请求频率，不撞 remoteLimit（300 次/分钟）。 */
export const RETRY_REMOTE_MS = 750;

export interface FeedRouteOptions<C> {
  mapCall: (row: CallRow) => C;
  /** 测试用：覆盖合并窗口。 */
  coalesceMs?: number;
}

const parseOffset = (raw: unknown): number | null => (typeof raw === 'string' && /^\d{1,16}$/.test(raw) ? Number(raw) : null);
const parseBoot = (raw: unknown): string | null => (typeof raw === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(raw) ? raw : null);
function parseWait(raw: unknown): number {
  const n = Number(typeof raw === 'string' ? raw : 0);
  return Number.isFinite(n) ? Math.min(MAX_WAIT_SECONDS, Math.max(0, n)) : 0;
}

/** 只有手机通道（/remote-api）的中间件会设 res.locals.channel。 */
const isRemote = (res: Response): boolean => (res.locals as { channel?: unknown }).channel !== undefined;

export function mountFeedRoutes<C>(router: Router, deps: DaemonDeps, opts: FeedRouteOptions<C>): void {
  const coalesceMs = opts.coalesceMs ?? COALESCE_MS;
  const sources = () => ({ toolCalls: deps.toolCalls, messages: deps.courier?.messageStore });

  async function serveFeed(req: Request, res: Response): Promise<void> {
    const id = String(req.params.id);
    const feed = deps.feed;
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.sessions.get(id)) { res.status(404).json({ error: 'session_not_found' }); return; }
    if (!feed) { res.status(503).json({ error: 'feed_unavailable' }); return; }

    const query = { offset: parseOffset(req.query.offset), boot: parseBoot(req.query.boot), limit: clampLimit(req.query.limit) };
    const wait = parseWait(req.query.wait);
    const remote = isRemote(res);
    const read = () => readFeed({ ...sources(), feed }, id, query, opts.mapCall);

    // 查询与挂起必须在同一个同步段里（中间不能有 await），否则会丢唤醒
    let result = read();
    let effectiveWait = wait;
    let retry = 0;
    if (!result.full && wait > 0 && !hasData(result)) {
      const abort = new AbortController();
      let gone = false;
      // 以 res 的 close + !writableFinished 判断客户端断开：req 的 close 在请求体被读完后也会触发，不等于连接断开
      const onClose = (): void => { if (!res.writableFinished) { gone = true; abort.abort(); } };
      res.on('close', onClose);
      let outcome: WaitResult;
      try {
        outcome = await feed.wait(id, wait, abort.signal);
        if (outcome === 'changed' && coalesceMs > 0 && !gone) await new Promise((resolve) => setTimeout(resolve, coalesceMs));
      } finally {
        res.off('close', onClose);
      }
      if (gone || outcome === 'aborted') return;
      if (outcome === 'closed' || !deps.sessions.get(id)) { res.status(404).json({ error: 'session_not_found' }); return; }
      if (outcome === 'degraded') { effectiveWait = 0; retry = RETRY_DEGRADED_MS; } // 超过等待者上限：立即返回，让客户端退让
      else if (outcome === 'shutdown') retry = RETRY_DEGRADED_MS;
      result = read();
    }

    const retryMs = retry || (result.more ? 0 : remote && hasData(result) ? RETRY_REMOTE_MS : 0);
    res.json({
      boot: feed.bootId,
      offset: result.offset,
      wait: effectiveWait,
      retry_ms: retryMs,
      full: result.full,
      more: result.more,
      ...(result.full ? { older: result.older } : {}),
      calls: result.calls,
      messages: result.messages,
      ...(result.state !== undefined ? { state: result.state } : {}),
    });
  }

  router.get('/sessions/:id/feed', (req, res) => {
    serveFeed(req, res).catch((error: unknown) => {
      deps.log(`feed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.status(500).json({ error: 'feed_failed' });
    });
  });

  router.get('/sessions/:id/history', (req, res) => {
    const id = String(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.sessions.get(id)) { res.status(404).json({ error: 'session_not_found' }); return; }
    const raw = req.query.before;
    const before = raw === undefined || raw === '' ? null : parseKey(raw);
    if (raw !== undefined && raw !== '' && !before) { res.status(400).json({ error: 'bad_cursor' }); return; }
    const page = pageTimeline(sources(), id, before, clampLimit(req.query.limit), opts.mapCall);
    res.json({ items: { calls: page.calls, messages: page.messages }, older: page.older });
  });
}
