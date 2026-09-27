import { createHash, randomBytes } from 'node:crypto';

/**
 * 短期 attachment store（plan §9，M3）：binary 结果只进这里（内存），agent 只看
 * 得到 metadata 与 [attachment:<id>] 占位；字节经 Panel 授权路由给人看。
 * 绑定 session + TTL（默认 30 分钟）+ 单个大小上限（默认 25MB）+ MIME allowlist；
 * session revoke / panel close / daemon stop 立即清理对应可见引用，文件本体随 TTL 过期。
 */

export const ATTACHMENT_MIME_ALLOWLIST = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/webm',
  'text/plain',
  'text/markdown',
];

export const DEFAULT_ATTACHMENT_TTL_MS = 30 * 60_000;
export const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export interface AttachmentMeta {
  sessionId: string;
  mimeType: string;
  bytes: Buffer;
  expiresAt: number;
  sizeBytes: number;
  sha256: string;
}

export interface AttachmentStoreOptions {
  ttlMs?: number;
  maxBytes?: number;
  /** 存活条目数上限（内存护栏）；满时新附件被拒绝（agent 收 error + hint）。 */
  maxEntries?: number;
}

export class AttachmentStore {
  private readonly entries = new Map<string, AttachmentMeta>();
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  /** 条目数上限：agent 无法用海量截图耗尽 daemon 内存（自审补充）。 */
  private readonly maxEntries: number;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(opts: AttachmentStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_ATTACHMENT_TTL_MS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
    this.maxEntries = opts.maxEntries ?? 20;
    // TTL 清扫：间隔取 TTL 的 1/10，至少 30s（测试可用短 TTL 驱动）
    const interval = Math.max(30_000, Math.floor(this.ttlMs / 10));
    this.sweeper = setInterval(() => this.sweep(), interval);
    this.sweeper.unref();
  }

  /** 占位 id：att_<session 前 8>_<随机>（plan §9）。 */
  makeId(sessionId: string): string {
    return `att_${sessionId.slice(0, 8)}_${randomBytes(6).toString('hex')}`;
  }

  /**
   * 存一份 binary。session 绑定（别的 session 取不到）；超限或 MIME 不在
   * allowlist → 抛错（tool.ts 映射为信封 error + hint）。
   */
  store(sessionId: string, bytes: Buffer, mimeType: string, id?: string): { id: string; expiresAt: number; sizeBytes: number; sha256: string } {
    if (bytes.length > this.maxBytes) {
      throw new AttachmentStoreError(`attachment exceeds the ${this.maxBytes} byte cap (${bytes.length})`);
    }
    // 先回收过期项再判满：TTL 已到的条目不该把新附件挡在门外
    this.sweep();
    if (this.entries.size >= this.maxEntries) {
      throw new AttachmentStoreError(`attachment store full (${this.maxEntries} live entries; wait for TTL expiry or reopen the panel)`);
    }
    const base = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
    const allowed = ATTACHMENT_MIME_ALLOWLIST.some((m) => (m.endsWith('/*') ? base.startsWith(m.slice(0, -1)) : base === m));
    if (!allowed) {
      throw new AttachmentStoreError(`attachment mime "${base}" is not in the allowlist`);
    }
    // id 由调用方传入（normalize 的占位标记与信封 meta 用同一 id）；缺省才自生成
    const finalId = id ?? this.makeId(sessionId);
    const expiresAt = Date.now() + this.ttlMs;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.entries.set(finalId, {
      sessionId,
      mimeType: base,
      bytes,
      expiresAt,
      sizeBytes: bytes.length,
      sha256,
    });
    return { id: finalId, expiresAt, sizeBytes: bytes.length, sha256 };
  }

  /** Panel 授权路由取字节：session 绑定 + 未过期才可见。 */
  get(sessionId: string, id: string): { mimeType: string; bytes: Buffer } | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.sessionId !== sessionId) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return { mimeType: entry.mimeType, bytes: entry.bytes };
  }

  /** session revoke / panel close 的可见引用清理。 */
  dropSession(sessionId: string): number {
    let dropped = 0;
    for (const [id, entry] of [...this.entries]) {
      if (entry.sessionId === sessionId) {
        this.entries.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** daemon stop：全部清理。 */
  clear(): void {
    this.entries.clear();
    if (this.sweeper !== undefined) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  private sweep(): void {
    const now = Date.now();
    for (const id of [...this.entries.keys()]) {
      const entry = this.entries.get(id);
      if (entry !== undefined && entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}

export class AttachmentStoreError extends Error {}
