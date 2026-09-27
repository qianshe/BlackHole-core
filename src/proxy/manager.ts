import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z as zod } from 'zod';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { VERSION } from '../version.js';
import { expandEnvRefs } from './config.js';
import type { ProxyServerConfig } from './types.js';
import { assignPidToKillOnCloseJob, closeJobHandle } from './win32job.js';
import type { NativePtr } from '../win32/ffi.js';

/**
 * upstream child 生命周期管理（plan §8）。职责边界：manager 只认识"进程/连接/
 * 超时/队列"，不认识 catalog、审批与 redaction——那些在 registry/policy/tool。
 * SDK 类型止步于此（plan §2.1）：对外只暴露 UpstreamToolResult 结构快照与领域错误。
 */

/** upstream 结果的结构快照（与 normalize.ts 的输入形状一致）。 */
export interface UpstreamToolResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

/** listTools 单页结果（M4 分页聚合用）。 */
export interface UpstreamToolPage {
  tools: UpstreamToolInfo[];
  nextCursor?: string;
}

export interface UpstreamToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

/** manager 的领域错误：tool.ts 按 kind 映射到信封 status（plan §4.1）。 */
export class ProxyUpstreamError extends Error {
  constructor(
    /** unavailable：spawn/connect/crash/maxChildren；timeout：call 超时；
     *  cancelled：operator 取消（M2）；error：协议层错误。 */
    public readonly kind: 'unavailable' | 'timeout' | 'cancelled' | 'error',
    message: string,
  ) {
    super(message);
  }
}

/** 有界 stderr 环形缓冲（plan §8.3）：64KB，旧数据淘汰；崩溃时取尾部脱敏后进 hint。 */
class StderrRing {
  private buf = '';
  private readonly capBytes: number;
  constructor(capBytes = 64 * 1024) {
    this.capBytes = capBytes;
  }
  push(chunk: Buffer | string): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let bytes = Buffer.byteLength(this.buf, 'utf8');
    if (bytes <= this.capBytes) return;
    // 从头部按行丢弃直到回到上限内：避免切在多字节字符中间
    const lines = this.buf.split('\n');
    while (bytes > this.capBytes && lines.length > 1) {
      lines.shift();
      bytes = Buffer.byteLength(lines.join('\n'), 'utf8');
    }
    this.buf = lines.join('\n');
    // 单行超限的兜底硬切（诊断摘要允许尾部字节级截断），否则单条巨型 stderr 永久驻留
    if (Buffer.byteLength(this.buf, 'utf8') > this.capBytes) {
      this.buf = Buffer.from(this.buf, 'utf8').subarray(-this.capBytes).toString('utf8');
    }
  }
  tail(maxBytes = 2 * 1024): string {
    const text = this.buf;
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    // 尾部硬切可接受：摘要是诊断线索，不是契约输出（脱敏发生在消费端）
    return text.slice(text.length - maxBytes);
  }
}

interface ChildEntry {
  server: string;
  /** scope:session 时为 session 主键；scope:shared 时为 SHARED_KEY。 */
  sessionId: string;
  client: Client;
  /** stdio 或 http（M4）；共性字段经 SDK 的 Transport 接口访问。 */
  transport: Transport;
  pid: number;
  startedAt: number;
  stderr: StderrRing;
  /** win32 kill-on-close job 句柄：child 存活期必须保持打开（plan §8.1）。 */
  job: NativePtr | null;
  /** 在途 call 计数：优雅回收（reload 优雅层）只在归零后关闭（plan §5.3）。 */
  inFlight: number;
  /** 优雅回收标记：在途归零即拆。 */
  retired: boolean;
  /** 空闲回收锚点（plan M4 idle recycle）。 */
  lastUsedAt: number;
}

const SHARED_KEY = '__shared__';

/** POSIX 下优先用 setsid 让 child 自成进程组：组杀才不会漏掉 npx 的下游 node。 */
const SETSID_CANDIDATES = ['/usr/bin/setsid', '/bin/setsid'];

function findSetsid(): string | null {
  if (process.platform !== 'linux') return null;
  for (const p of SETSID_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* probe next */
    }
  }
  return null;
}

/** /proc/<pid>/stat 的 starttime（第 22 字段，jiffies）——pid 复用防护的唯一可靠锚点。 */
function posixStartTicks(pid: number): string | null {
  if (process.platform === 'win32') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(') ') + 2);
    const fields = after.split(' ');
    return fields[19] ?? null; // fields[0] 是第 3 字段 state：第 22 字段下标 19
  } catch {
    return null;
  }
}

interface PidRecord {
  server: string;
  sessionId: string;
  pid: number;
  startedAt: number;
  posixStartTicks: string | null;
}

export interface ProxyManagerOptions {
  /** pid registry 落盘目录（与 db 同目录）；必须已存在。 */
  dataDir: string;
  log: (line: string) => void;
  /**
   * 统一脱敏管道（plan §8.3/§16）：stderr 摘要、崩溃 note 等任何要进日志或
   * list reason 的文本都必须先过这里（键掩码 + env secret 值扫描）。
   */
  redact?: (text: string) => string;
  /** M4 catalog change subscription（plan §12-M4）：upstream 通知 tools/list 变化。 */
  onToolsChanged?: (server: string) => void;
  /** Enabled upstream exited unexpectedly; runtime owns bounded recovery policy. */
  onUnexpectedClose?: (server: string) => void;
}

export class ProxyManager {
  private readonly children = new Map<string, ChildEntry>();
  /** 同 session+server 的调用逐个执行（plan §8.2）；读路径（listTools）不入队。 */
  private queues = new Map<string, Promise<unknown>>();
  /** 并发去重的 spawn 锁：多个 waiter 共享同一次启动（不会嵌套进 call 队列）。 */
  private spawnLocks = new Map<string, Promise<ChildEntry>>();
  /** 在途 spawn 计数：与 children.size 一起构成 maxChildren 的额度视图。 */
  private spawning = 0;
  /** 最近一次异常退出的诊断（server 名 → 摘要），status=crashed 时展示。 */
  private crashNotes = new Map<string, string>();
  /** M4 熔断器：连续失败计数与打开截止时间（per server）。 */
  private breaker = new Map<string, { failures: number; openUntil: number }>();
  /** reload 身份层移除的 server：队列中残留的旧调用在 spawn 前快速失败（plan §5.3）。 */
  private removedServers = new Set<string>();
  private serverRevisions = new Map<string, number>();
  private connecting = new Map<string, ChildEntry>();
  private retiring = new Map<ChildEntry, string>();
  private closed = false;
  /** M4 指标：重启计数 / 调用计数 / 延迟直方图 / 最近错误。 */
  private metrics = new Map<string, { restarts: number; calls: number; lastError: string | null; latencyBuckets: [number, number, number, number] }>();
  private readonly pidFile: string;
  private readonly setsidPath: string | null = findSetsid();
  private idleSweeper: NodeJS.Timeout | undefined;

  constructor(private readonly opts: ProxyManagerOptions) {
    this.pidFile = path.join(opts.dataDir, 'proxy-children.json');
    // M4 idle recycle：60s 周期扫描空闲 child（超时由 closeIdle 对齐）
    this.idleSweeper = setInterval(() => this.sweepIdle(), 60_000);
    this.idleSweeper.unref();
  }

  // ── 状态查询 ──────────────────────────────────────────────

  childCount(): number {
    return this.children.size;
  }

  /** 该 server 是否已有活 child（list 状态展示用，绝不因此 spawn）。 */
  hasLiveChild(server: string): boolean {
    for (const key of this.children.keys()) {
      if (key.startsWith(`${server}:`)) return true;
    }
    return false;
  }

  /** 该 server 任一活 child 的 session 主键（list_changed 刷新用）；无则 null。 */
  firstLiveSession(server: string): string | null {
    for (const [key, entry] of this.children) {
      if (key.startsWith(`${server}:`)) return entry.sessionId;
    }
    return null;
  }

  /** 该 server 是否有 spawn/握手正在进行（list 的 starting 状态）。 */
  isStarting(server: string): boolean {
    for (const key of this.spawnLocks.keys()) {
      if (key.startsWith(`${server}:`)) return true;
    }
    return false;
  }

  crashNote(server: string): string | undefined {
    return this.crashNotes.get(server);
  }

  clearCrashNote(server: string): void {
    this.crashNotes.delete(server);
  }

  markStartFailure(server: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const note = this.redactText(`upstream "${server}" failed to start: ${message}`);
    this.crashNotes.set(server, note);
    this.metricsFor(server).lastError = note.slice(0, 300);
    this.opts.log(`proxy: ${note}`);
  }

  // ── 生命周期 ──────────────────────────────────────────────

  private scopeKey(server: ProxyServerConfig, _sessionId: string): string {
    return `${server.name}:${SHARED_KEY}`;
  }

  /** 所有面向日志/crashNotes 的文本统一出口（plan §8.3/§16）。 */
  private redactText(text: string): string {
    return this.opts.redact?.(text) ?? text;
  }

  /** 串行入队：前一个失败不影响下一个执行（队列链上吞掉尾态）；空闲键即时清理。 */
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      // 该键没有排队中的后继时移除：queueDepth 与内存都不留已完成残迹
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return next;
  }

  /** Enabled MCP lifecycle: start one daemon-owned upstream before it can be used. */
  async start(server: ProxyServerConfig): Promise<void> {
    await this.ensureChild(server, SHARED_KEY);
  }

  private requireChild(server: ProxyServerConfig, sessionId: string): ChildEntry {
    const entry = this.children.get(this.scopeKey(server, sessionId));
    if (!entry || entry.retired) {
      const reason = this.crashNotes.get(server.name);
      throw new ProxyUpstreamError('unavailable', reason ?? `upstream "${server.name}" is not running; enable or retry it in BlackHole settings`);
    }
    return entry;
  }

  /**
   * 取到该 session+server 的活 child；没有则启动（并发 waiter 共享同一次
   * spawn——spawn 锁独立于调用队列，绝不嵌套进队列，否则锁等待自己会死锁）。
   */
  private ensureChild(server: ProxyServerConfig, sessionId: string): Promise<ChildEntry> {
    if (this.closed || !server.enabled || this.removedServers.has(server.name)) {
      throw new ProxyUpstreamError('unavailable', `upstream "${server.name}" is disabled or removed`);
    }
    this.assertClosed(server.name);
    const key = this.scopeKey(server, sessionId);
    const existing = this.children.get(key);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.spawnLocks.get(key);
    if (inFlight) return inFlight;
    // 预算检查放在这里：在途 spawn 也占额度，否则不同 key 的并发 spawn 会各自
    // 看到同一个"未超限"快照，一起冲过 maxChildren
    this.assertChildBudget(server);
    this.spawning += 1;
    const p = this.spawnChild(server, sessionId, key).finally(() => {
      this.spawning -= 1;
      if (this.spawnLocks.get(key) === p) this.spawnLocks.delete(key);
    });
    this.spawnLocks.set(key, p);
    return p;
  }

  private async spawnChild(server: ProxyServerConfig, sessionId: string, key: string): Promise<ChildEntry> {
    const shared = true; // enabled MCPs are daemon-owned, one live connection per server
    const revision = this.serverRevisions.get(server.name) ?? 0;

    // setsid 包一层：child 自成进程组，组杀才覆盖 npx 的下游（plan §8.1）
    const useSetsid = process.platform === 'linux' && this.setsidPath !== null;
    const command = useSetsid ? this.setsidPath! : server.command;
    const args = useSetsid ? [server.command, ...server.args] : server.args;

    const env: Record<string, string> = {};
    for (const k of server.env.inherit) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    // env.set 值支持 ${ENV_VAR} 机密引用（plan §12-M4）：与 HTTP headers 同一展开规则，
    // 未展开的模板串绝不出现在 child 环境里（否则等于把引用当值注入）
    for (const [k, v] of Object.entries(server.env.set)) env[k] = expandEnvRefs(v);
    // setFromFile（plan §5/§M2）：{ KEY: 文件路径 }，spawn 时读单行值——值不进配置、不进日志
    for (const [key, file] of Object.entries(server.env.setFromFile ?? {})) {
      try {
        const value = fs.readFileSync(file, 'utf8').split(/\r?\n/, 1)[0]?.trim() ?? '';
        if (value !== '') env[key] = value;
      } catch (e) {
        throw new ProxyUpstreamError('unavailable', `upstream "${server.name}" env.setFromFile[${key}]: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const client = new Client({ name: 'blackhole-proxy', version: VERSION });
    const isHttp = server.transport === 'http';
    const transport: StdioClientTransport | StreamableHTTPClientTransport = isHttp
      ? new StreamableHTTPClientTransport(new URL(server.url!), {
          requestInit: {
            headers: Object.fromEntries(
              Object.entries(server.headers ?? {}).map(([k, v]) => [k, expandEnvRefs(v)]),
            ),
          },
        })
      : new StdioClientTransport({ command, args, env, stderr: 'pipe' });
    const entry: ChildEntry = {
      server: server.name,
      sessionId: shared ? SHARED_KEY : sessionId,
      client,
      transport,
      pid: 0,
      startedAt: Date.now(),
      stderr: new StderrRing(),
      job: null,
      inFlight: 0,
      retired: false,
      lastUsedAt: Date.now(),
    };

    if (transport instanceof StdioClientTransport) {
      transport.stderr?.on('data', (chunk: Buffer | string) => entry.stderr.push(chunk));
    } else if (this.opts.onToolsChanged !== undefined) {
      // HTTP upstream 的目录变化订阅（stdio 的 listChanged 在 M4 未启用——
      // stdio child 的 catalog 已由 TTL + not-found 刷新覆盖）
      const changedServer = server.name;
      client.setNotificationHandler(
        zod.object({ method: zod.literal('notifications/tools/list_changed') }).passthrough(),
        () => this.opts.onToolsChanged?.(changedServer),
      );
    }

    // transport.onclose = child 退出（stdin/stdout 关闭）：清理 entry、留 crash 摘要
    transport.onclose = () => {
      if (this.children.get(key) === entry) {
        this.children.delete(key);
        this.unregisterPid(entry.pid);
        closeJobHandle(entry.job);
        // plan §8.3/§16：stderr 摘要进日志与 crashNotes 之前必须过统一脱敏管道
        const note = this.redactText(`upstream "${server.name}" exited; stderr tail: ${entry.stderr.tail(400).trim() || '(empty)'}`);
        this.crashNotes.set(server.name, note);
        this.opts.log(`proxy: ${note}`);
        if (!entry.retired && !this.closed && !this.removedServers.has(server.name)) this.opts.onUnexpectedClose?.(server.name);
      }
    };

    try {
      this.connecting.set(key, entry);
      await this.withTimeout(client.connect(transport), server.limits?.connectTimeoutMs ?? 15_000, 'connect');
      if (this.closed || entry.retired || this.removedServers.has(server.name) || revision !== (this.serverRevisions.get(server.name) ?? 0)) {
        throw new ProxyUpstreamError('unavailable', `upstream "${server.name}" changed while connecting`);
      }
      const pid = transport instanceof StdioClientTransport ? transport.pid : null;
      if (pid !== null) {
        entry.pid = pid;
        // Windows 硬保证（plan §8.1）：kill-on-close job；失败即启动失败，不留裸 child
        if (process.platform === 'win32') {
          entry.job = assignPidToKillOnCloseJob(pid);
        }
        this.registerPid(server.name, entry.sessionId, pid, entry.startedAt);
      }
      this.crashNotes.delete(server.name);
      this.metricsFor(server.name).lastError = null;
      this.metricsFor(server.name).restarts += 1;
      this.opts.log(`proxy: upstream "${server.name}" started (${isHttp ? server.url : `pid ${pid ?? '?'}`}${shared ? ', shared' : `, session ${sessionId}`})`);
    } catch (e) {
      // A late failed connect must not delete a newer instance with the same name.
      if (this.connecting.get(key) === entry) this.connecting.delete(key);
      if (this.children.get(key) === entry) this.children.delete(key);
      this.unregisterPid(entry.pid);
      closeJobHandle(entry.job);
      try {
        void entry.client.close().catch(() => undefined);
      } catch {
        /* never connected */
      }
      if (e instanceof ProxyUpstreamError) throw e;
      throw new ProxyUpstreamError('unavailable', `upstream "${server.name}" failed to start: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (this.connecting.get(key) === entry) this.connecting.delete(key);
    this.children.set(key, entry);
    return entry;
  }

  /** plan §5 limits.maxChildren：daemon 级 child 总数上限（per-server 覆盖全局默认值）。 */
  private assertChildBudget(server: ProxyServerConfig): void {
    const cap = server.limits?.maxChildren ?? 8;
    // 计入"正在 spawn"的额度：不同 key 的并发 spawn 不能各自看到同一个未超限快照
    if (this.children.size + this.spawning >= cap) {
      throw new ProxyUpstreamError(
        'unavailable',
        `upstream child budget exhausted (${this.children.size}/${cap}); retry later or free idle upstreams`,
      );
    }
  }

  private killPid(pid: number, signal?: NodeJS.Signals): boolean {
    // pid<=0 会信号到调用者自己的进程组（POSIX 语义），绝不放行；http 无进程
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, signal ?? 'SIGTERM'); // 自成进程组时按组杀
          return true;
        } catch {
          /* fall through to single-pid kill */
        }
      }
      process.kill(pid, signal ?? 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }

  // ── 调用执行 ──────────────────────────────────────────────

  /**
   * 执行一次 upstream call。串行语义（plan §8.2）：同 session+server 逐个执行
   * （scope:shared 时全 session 共用一条队列，plan §10 的全局互斥）。call 超时映射
   * ProxyUpstreamError('timeout')——副作用未知，由 tool.ts 出固定 hint；**不自动重放**
   * （plan §8.3）。signal 由 M2 的 operator 取消入口触发：abort → cancelled → 上游
   * 请求尽力取消（SDK cancellation），本地立刻 terminal。
   *
   * `gate`（plan §8.2）：审批等待发生在**队列之内**——未获许可的 mutation 不得被
   * 后续已获许可的 mutation 插队，且审批超时/取消天然释放队列槽位。gate 抛出的
   * 错误原样向上传递（tool.ts 用它携带 denied 信封），不触发熔断与指标。
   */
  async call(
    server: ProxyServerConfig,
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
    gate?: () => Promise<void>,
    beforeDispatch?: () => Promise<void>,
  ): Promise<UpstreamToolResult> {
    const key = this.scopeKey(server, sessionId);
    return this.enqueue(key, async () => {
      this.assertClosed(server.name);
      if (this.removedServers.has(server.name)) {
        throw new ProxyUpstreamError('unavailable', `upstream "${server.name}" was removed by a config reload; use command=list to see current servers`);
      }
      if (gate !== undefined) await gate();
      const entry = this.requireChild(server, sessionId);
      await beforeDispatch?.();
      entry.inFlight += 1;
      const started = Date.now();
      try {
        const result = await entry.client.callTool(
          { name: tool, arguments: args },
          undefined,
          { timeout: timeoutMs, ...(signal !== undefined ? { signal } : {}) },
        );
        entry.lastUsedAt = Date.now();
        this.recordSuccess(server.name, Date.now() - started);
        return result as UpstreamToolResult;
      } catch (e) {
        const err = this.mapCallError(server.name, e);
        entry.lastUsedAt = Date.now();
        // 取消不算失败；参数校验类错误（-32602）是调用方问题，不能熔断整个 server；
        // 其余（超时/不可用/连接级协议错误）计入熔断器与指标
        const validationError = e instanceof Error && /-32602|Invalid arguments/i.test(e.message);
        if (err.kind !== 'cancelled' && !validationError) this.recordFailure(server.name, err.message, Date.now() - started);
        throw err;
      } finally {
        entry.inFlight -= 1;
        if (entry.retired && entry.inFlight === 0) {
          this.teardownEntry(key, entry);
        }
      }
    });
  }

  /**
   * listTools（catalog 读取，plan §6.3/§8.2）：读路径**不入串行队列**——JSON-RPC
   * 在同一 stdio 连接上多路复用，与在途 mutation 并行是协议安全的；仅首次
   * 连接经由 spawn 锁，命中已有 child 时完全绕开队列。
   */
  async listTools(server: ProxyServerConfig, sessionId: string, timeoutMs: number, cursor?: string, startIfMissing = false): Promise<UpstreamToolPage> {
    const entry = startIfMissing ? await this.ensureChild(server, sessionId) : this.requireChild(server, sessionId);
    try {
      const res = await entry.client.listTools(cursor !== undefined ? { cursor } : {}, { timeout: timeoutMs });
      // nextCursor 透传给 registry 做分页聚合（plan §6.3 大目录）
      return { tools: (res.tools ?? []) as UpstreamToolInfo[], nextCursor: res.nextCursor };
    } catch (e) {
      throw this.mapCallError(server.name, e);
    }
  }

  private mapCallError(server: string, e: unknown): ProxyUpstreamError {
    if (e instanceof ProxyUpstreamError) return e;
    const message = e instanceof Error ? e.message : String(e);
    if (/abort/i.test(message)) return new ProxyUpstreamError('cancelled', `upstream "${server}" call cancelled by operator`);
    if (/timed out/i.test(message)) return new ProxyUpstreamError('timeout', `upstream "${server}" call timed out`);
    return new ProxyUpstreamError('error', `upstream "${server}" call failed: ${message}`);
  }

  private withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ProxyUpstreamError('unavailable', `${what} timed out after ${ms}ms`)), ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  // ── M4 熔断器 / 指标 / 优雅回收（plan §12-M4）──────────────

  private recordSuccess(server: string, latencyMs: number): void {
    this.breaker.delete(server);
    // 一次成功即清掉上次崩溃的 note：否则 child 空闲关闭后 list 又退回 crashed
    this.crashNotes.delete(server);
    const m = this.metricsFor(server);
    m.calls += 1;
    if (latencyMs <= 100) m.latencyBuckets[0] += 1;
    else if (latencyMs <= 1000) m.latencyBuckets[1] += 1;
    else if (latencyMs <= 5000) m.latencyBuckets[2] += 1;
    else m.latencyBuckets[3] += 1;
  }

  private recordFailure(server: string, message: string, latencyMs: number): void {
    const m = this.metricsFor(server);
    m.calls += 1;
    m.lastError = message.slice(0, 300);
    if (latencyMs <= 100) m.latencyBuckets[0] += 1;
    else if (latencyMs <= 1000) m.latencyBuckets[1] += 1;
    else if (latencyMs <= 5000) m.latencyBuckets[2] += 1;
    else m.latencyBuckets[3] += 1;
    // 指数退避熔断：连续 3 次失败后打开，冷却 5s→10s→20s（上限 60s）
    const b = this.breaker.get(server) ?? { failures: 0, openUntil: 0 };
    b.failures += 1;
    if (b.failures >= 3) {
      const cooldown = Math.min(60_000, 5_000 * 2 ** (b.failures - 3));
      b.openUntil = Date.now() + cooldown;
    }
    this.breaker.set(server, b);
  }

  /** 熔断打开期间快速失败（plan §12-M4 circuit-breaker）。 */
  private assertClosed(server: string): void {
    const b = this.breaker.get(server);
    if (b !== undefined && b.openUntil > Date.now()) {
      throw new ProxyUpstreamError('unavailable', `upstream "${server}" is circuit-open after repeated failures; retry after ${Math.ceil((b.openUntil - Date.now()) / 1000)}s`);
    }
  }

  private metricsFor(server: string): { restarts: number; calls: number; lastError: string | null; latencyBuckets: [number, number, number, number] } {
    let m = this.metrics.get(server);
    if (m === undefined) {
      m = { restarts: 0, calls: 0, lastError: null, latencyBuckets: [0, 0, 0, 0] };
      this.metrics.set(server, m);
    }
    return m;
  }

  /** M4 指标快照（/api/proxies）。 */
  metricsSnapshot(server: string): { restarts: number; calls: number; lastError: string | null; latencyBuckets: [number, number, number, number]; queueDepth: number } {
    const m = this.metricsFor(server);
    return { ...m, queueDepth: this.queueDepth(server) };
  }

  /** 每 server 的队列深度（在途 + 排队，含全部 session）。 */
  queueDepth(server: string): number {
    let depth = 0;
    for (const key of this.queues.keys()) {
      if (key.startsWith(`${server}:`)) depth += 1;
    }
    for (const key of this.spawnLocks.keys()) {
      if (key.startsWith(`${server}:`)) depth += 1;
    }
    return depth;
  }

  /**
   * reload 的进程侧（plan §5.3）：
   * - identity：立即拆（in-flight 拿 unavailable）；
   * - graceful：空闲 child 立即回收，在途的标记 retired、归零即拆。
   */
  closeServer(server: string, mode: 'identity' | 'graceful'): void {
    this.serverRevisions.set(server, (this.serverRevisions.get(server) ?? 0) + 1);
    for (const [key, entry] of this.connecting) {
      if (entry.server !== server) continue;
      if (entry.transport instanceof StdioClientTransport) entry.pid = entry.transport.pid ?? 0;
      this.teardownEntry(key, entry);
      this.connecting.delete(key);
      this.spawnLocks.delete(key);
    }
    if (mode === 'identity') this.removedServers.add(server);
    for (const [key, entry] of [...this.children]) {
      if (entry.server !== server) continue;
      if (mode === 'identity' || entry.inFlight === 0) {
        this.teardownEntry(key, entry);
      } else {
        entry.retired = true;
        this.retiring.set(entry, key);
        // New calls use the replacement config; only the in-flight call keeps this child.
        if (this.children.get(key) === entry) this.children.delete(key);
      }
    }
    this.breaker.delete(server);
  }

  /** reload 重新加入同名 server：解除移除标记。 */
  reAddServer(server: string): void {
    this.removedServers.delete(server);
  }

  /** M4 idle recycle：空闲超过 idleMs 的 child 关闭（下次 call 按需重启）。 */
  closeIdle(idleMs: number): number {
    const cutoff = Date.now() - idleMs;
    let closed = 0;
    for (const [key, entry] of [...this.children]) {
      if (entry.inFlight === 0 && entry.lastUsedAt < cutoff) {
        this.teardownEntry(key, entry);
        closed += 1;
      }
    }
    return closed;
  }

  private sweepIdle(): void {
    if (this.idleMs > 0) this.closeIdle(this.idleMs);
  }

  /** 空闲回收阈值（0 = 关闭）；daemon 装配时注入。 */
  setIdleRecycle(idleMs: number): void {
    this.idleMs = idleMs;
  }

  private idleMs = 0;

  // ── 清理路径（plan §8.1）───────────────────────────────────

  /** session revoke/archive：该 session 的所有 upstream child 关闭。 */
  async closeSession(sessionId: string): Promise<void> {
    for (const [key, entry] of [...this.children]) {
      if (entry.sessionId === sessionId) await this.closeEntry(key, entry);
    }
  }

  /** daemon stop（优雅）：全部 upstream child 在进程退出前关闭（plan §8.1）。 */
  async closeAll(): Promise<void> {
    this.closed = true;
    if (this.idleSweeper) clearInterval(this.idleSweeper);
    for (const entry of [...this.connecting.values()]) this.closeServer(entry.server, 'identity');
    for (const [entry, key] of [...this.retiring]) await this.closeEntry(key, entry);
    for (const [key, entry] of [...this.children]) {
      await this.closeEntry(key, entry);
    }
  }

  /** 单个 child 的立即拆解（reload 身份层 / 空闲回收 / 优雅回收归零后）。 */
  private teardownEntry(key: string, entry: ChildEntry): void {
    entry.retired = true;
    this.retiring.delete(entry);
    if (this.children.get(key) === entry) this.children.delete(key);
    this.unregisterPid(entry.pid);
    closeJobHandle(entry.job);
    try {
      void entry.client.close().catch(() => undefined);
    } catch {
      /* already gone */
    }
    // 兜底强杀：client.close() 只是关连接，不理会 stdin EOF 的 child 要靠这里收掉
    this.scheduleKill(entry.pid);
  }

  private async closeEntry(key: string, entry: ChildEntry): Promise<void> {
    entry.retired = true;
    this.retiring.delete(entry);
    if (this.children.get(key) === entry) this.children.delete(key);
    this.unregisterPid(entry.pid);
    closeJobHandle(entry.job);
    try {
      const done = entry.client.close();
      if (done instanceof Promise) await done;
    } catch {
      /* force-kill below regardless */
    }
    // POSIX：立刻按进程组补一次 SIGTERM。优雅关闭已经发生，这一步只为确定性——
    // 组杀失败（进程已死）会被 killPid 吞掉；Windows 由 Job Object 兜底。
    if (process.platform !== 'win32') this.killPid(entry.pid, 'SIGTERM');
    this.scheduleKill(entry.pid);
    void key;
  }

  /**
   * 宽限 2s 后按组 SIGKILL 兜底。定时器 unref：不阻塞进程退出，但一旦事件循环
   * 还活着（daemon 正常运行、reload、idle 回收）就一定会执行。
   */
  private scheduleKill(pid: number): void {
    setTimeout(() => {
      this.killPid(pid, 'SIGKILL');
    }, 2_000).unref();
  }

  // ── pid registry（plan §8.1）───────────────────────────────

  private readPidRecords(): PidRecord[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.pidFile, 'utf8')) as PidRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writePidRecords(records: PidRecord[]): void {
    try {
      if (records.length === 0) {
        fs.rmSync(this.pidFile, { force: true });
      } else {
        fs.writeFileSync(this.pidFile, JSON.stringify(records, null, 1));
      }
    } catch (e) {
      this.opts.log(`proxy: pid registry write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private registerPid(server: string, sessionId: string, pid: number, startedAt: number): void {
    const records = this.readPidRecords().filter((r) => r.pid !== pid);
    records.push({ server, sessionId, pid, startedAt, posixStartTicks: posixStartTicks(pid) });
    this.writePidRecords(records);
  }

  private unregisterPid(pid: number): void {
    if (pid <= 0) return;
    this.writePidRecords(this.readPidRecords().filter((r) => r.pid !== pid));
  }

  /**
   * daemon 启动孤儿清扫（plan §8.1）：回收上次运行残留（registry 写入后 daemon
   * 才崩溃的窗口、以及无 Job Object 的 POSIX 路径）。pid 复用防护：POSIX 比对
   * /proc starttime，匹配才杀；Windows 侧 Job Object 已是硬保证，清扫只清账
   * 不杀进程——拿不到等价锚点，宁可放过不可错杀。
   */
  sweepOrphansAtBoot(): number {
    const records = this.readPidRecords();
    if (records.length === 0) return 0;
    let killed = 0;
    for (const r of records) {
      if (process.platform !== 'win32') {
        const now = posixStartTicks(r.pid);
        if (now !== null && now === r.posixStartTicks) {
          this.killPid(r.pid, 'SIGKILL');
          killed += 1;
        }
      } else {
        this.opts.log(`proxy: stale pid registry entry (pid ${r.pid}, server ${r.server}); Windows cleanup is the Job Object's job`);
      }
    }
    this.writePidRecords([]);
    if (killed > 0) this.opts.log(`proxy: swept ${killed} orphaned upstream process(es) from the previous run`);
    return killed;
  }
}
