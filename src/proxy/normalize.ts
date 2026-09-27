/**
 * upstream call 结果 → BlackHole 稳定信封 content 部分的纯归一化（plan §4.2/§9）。
 * 全部纯函数、零 IO、不 import SDK：upstream 的块形状用本模块的宽松结构类型描述，
 * 绝不让 @modelcontextprotocol/sdk 的类型出现在任何签名里（plan §2.1 铁律）。
 * 本模块只决定“留什么/丢什么/怎么标记”；isError→status 映射与敏感值脱敏归 tool.ts。
 */
import { createHash } from 'node:crypto';
import { PROXY_CAPS, type ProxyAttachmentKind, type ProxyAttachmentMeta } from './types.js';

/** upstream 内容块的结构快照：字段全部可选、结构宽松，以容忍不同 upstream 的实现差异。 */
export interface UpstreamContentBlock {
  type: string; // 'text' | 'image' | 'audio' | 'resource' | 其他
  text?: string;
  /** base64（image/audio）。 */
  data?: string;
  mimeType?: string;
  name?: string;
  /** resource 块的内嵌资源（uri/blob/text 任一形态），能取到字节就算二进制。 */
  resource?: { uri?: string; blob?: string; mimeType?: string; text?: string };
}

/** upstream tool 结果的结构快照。isError 不在此处理（tool.ts 负责映射 status，plan §4.1）。 */
export interface UpstreamToolResult {
  content?: UpstreamContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** 归一化产物：稳定信封（plan §4）的 content 部分；dataJson 超限时整体缺省。 */
export interface NormalizedContent {
  /** 按块序合并的 text（可能为空串）；二进制块以 [attachment:<id>] 占位保留相对位置。 */
  text: string;
  /** structuredContent 的序列化；超限/不可序列化时整体省略（绝不输出半个 JSON，plan §4.2）。 */
  dataJson?: string;
  truncated: boolean;
  attachments: ProxyAttachmentMeta[];
}

/** plan §4.2 的固定截断标记；必须完整输出，为此允许追加后总长略微超过 textBytes。 */
const TEXT_TRUNCATED_MARKER = '…[text truncated]';

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** upstream 数据不可信：字段类型随时可能不是声明的样子，统一先收窄成 string | undefined。 */
function guardString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** JSON.stringify 的容错包装：循环引用等不可序列化值返回 undefined 而不是向调用方抛异常。 */
function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * 追加一条 attachment 元数据。sizeBytes/sha256 都按**解码后的真实字节**计算
 * （plan §4.2/§9）；无字节（缺 data/blob 或空串）时两者都缺省。
 */
function pushAttachment(
  attachments: ProxyAttachmentMeta[],
  base: { id: string; kind: ProxyAttachmentKind; mimeType?: string; name?: string },
  b64: string | undefined,
  onBinary?: (id: string, bytes: Buffer, mimeType: string) => void,
): void {
  const meta: ProxyAttachmentMeta = { id: base.id, kind: base.kind };
  if (base.mimeType !== undefined) meta.mimeType = base.mimeType;
  if (base.name !== undefined) meta.name = base.name;
  if (b64 !== undefined && b64.length > 0) {
    const bytes = Buffer.from(b64, 'base64');
    meta.sizeBytes = bytes.length;
    meta.sha256 = sha256Hex(bytes);
    // M3 字节通道：交给调用方的 store（normalize 自身零 IO）
    onBinary?.(base.id, bytes, base.mimeType ?? 'application/octet-stream');
  }
  attachments.push(meta);
}

/** 从 uri 取文件名部分（末段，去掉 query/fragment）；取不到（如以 / 结尾）就不给 name。 */
function fileNameFromUri(uri: string): string | undefined {
  const seg = uri.replace(/[?#].*$/, '').replace(/.*[/\\]/, '');
  return seg.length > 0 ? seg : undefined;
}

/**
 * 按块边界合并（plan §4.2）：完整装得下的段保留，从装不下的那一段起整体丢弃，
 * 尾部追加完整标记——因此标记追加后总长可能仍略超上限，可接受。
 * 不做段内截断：半段正文比丢整段更容易让 agent 误读上游语义。
 */
function mergeAtBlockBoundary(segments: string[]): { text: string; truncated: boolean } {
  const kept: string[] = [];
  let total = 0;
  for (const seg of segments) {
    // '\n' 连接符本身也占字节，一并计入 text 上限。
    const cost = (kept.length > 0 ? 1 : 0) + utf8Bytes(seg);
    if (total + cost > PROXY_CAPS.textBytes) {
      const text =
        kept.length > 0 ? `${kept.join('\n')}\n${TEXT_TRUNCATED_MARKER}` : TEXT_TRUNCATED_MARKER;
      return { text, truncated: true };
    }
    total += cost;
    kept.push(seg);
  }
  return { text: kept.join('\n'), truncated: false };
}

/**
 * plan §4.2 的结果归一化：
 * - text 块按块序以 \n 合并，超 32KB 在块边界截断并追加完整标记；
 * - image/audio/resource（有 blob 或 uri）以 [attachment:<id>] 占位保留相对位置，元数据进 attachments；
 * - 未知 type 只带 text 时按正文处理，否则跳过内容、text 末尾占位、kind=file；
 * - structuredContent 序列化 ≤128KB，超限整体省略 dataJson 并置 truncated。
 * attachment 元数据与 text 截断彼此独立：即便某占位被 text 上限挤掉，元数据照记——
 * 字节通道（§9 attachment store）不依赖 text 是否装得下。
 */
export function normalizeUpstreamContent(
  raw: UpstreamToolResult,
  // kind 含 'file'：未知类型块的末尾占位（plan §4.2 c）同样需要 id。
  makeAttachmentId: (kind: 'image' | 'audio' | 'resource' | 'file') => string,
  // M3：字节捕获回调——store 在 tool.ts 侧，normalize 本身保持零 IO。
  onBinary?: (id: string, bytes: Buffer, mimeType: string) => void,
): NormalizedContent {
  const attachments: ProxyAttachmentMeta[] = [];
  // 按 upstream 块序参与 text 合并的段：正文片段与二进制占位标记。
  const segments: string[] = [];
  // 未知类型块的占位不参与块序合并，一律追加在 text 末尾（plan §4.2 c）。
  const tailSegments: string[] = [];

  const blocks: unknown[] = Array.isArray(raw.content) ? raw.content : [];
  for (const item of blocks) {
    if (typeof item !== 'object' || item === null) continue;
    const block = item as UpstreamContentBlock;
    const text = guardString(block.text);
    const data = guardString(block.data);
    const mimeType = guardString(block.mimeType);
    const name = guardString(block.name);
    const res =
      typeof block.resource === 'object' && block.resource !== null ? block.resource : undefined;
    const resBlob = guardString(res?.blob);
    const resUri = guardString(res?.uri);
    const resText = guardString(res?.text);
    const resMime = guardString(res?.mimeType);

    if (block.type === 'text') {
      // a 步：text 块按块序进合并序列；空串跳过，避免产生多余换行。
      if (text !== undefined && text.length > 0) segments.push(text);
    } else if (block.type === 'image' || block.type === 'audio') {
      // b 步：image/audio 一律二进制占位；无 data 也要留占位与元数据（可能只是引用形态）。
      const id = makeAttachmentId(block.type);
      segments.push(`[attachment:${id}]`);
      pushAttachment(attachments, { id, kind: block.type, mimeType, name }, data, onBinary);
    } else if (block.type === 'resource') {
      if (resBlob !== undefined || resUri !== undefined) {
        // b 步：有 blob 或 uri 即按二进制占位；blob 与 text 并存时 blob 赢——绝不把混合 payload 当正文。
        const id = makeAttachmentId('resource');
        segments.push(`[attachment:${id}]`);
        pushAttachment(
          attachments,
          {
            id,
            kind: 'resource',
            mimeType: mimeType ?? resMime,
            name: name ?? (resUri !== undefined ? fileNameFromUri(resUri) : undefined),
          },
          resBlob,
        );
      } else if (resText !== undefined && resText.length > 0) {
        // b 步：resource 纯 text 形态不算二进制，按 a 步并入正文。
        segments.push(resText);
      } else if (text !== undefined && text.length > 0) {
        // 个别 upstream 把 text 挂在块上而非 resource 内：同为纯文本形态，按 a 步处理。
        segments.push(text);
      }
      // 其余（无 blob/uri/text 的空 resource 壳）没有可表示的内容，直接跳过。
    } else if (text !== undefined && data === undefined && block.resource === undefined) {
      // c 步：未知 type 但只带 text 字段——按正文处理（空串不产生段）。
      if (text.length > 0) segments.push(text);
    } else {
      // c 步：未知 type 且不止 text——绝不猜 payload：内容跳过，text 末尾占位，kind=file。
      const id = makeAttachmentId('file');
      tailSegments.push(`[attachment:${id}]`);
      pushAttachment(attachments, { id, kind: 'file', mimeType, name }, data, onBinary);
    }
  }

  const merged = mergeAtBlockBoundary([...segments, ...tailSegments]);
  let truncated = merged.truncated;

  // d 步：structuredContent 序列化；超限/不可序列化 → 整体省略 dataJson 并置 truncated
  //（任何情况下不得输出半个 JSON，plan §4.2）。
  let dataJson: string | undefined;
  if (raw.structuredContent !== undefined) {
    const json = safeStringify(raw.structuredContent);
    if (json !== undefined && utf8Bytes(json) <= PROXY_CAPS.dataJsonBytes) {
      dataJson = json;
    } else {
      truncated = true;
    }
  }

  return dataJson === undefined
    ? { text: merged.text, truncated, attachments }
    : { text: merged.text, dataJson, truncated, attachments };
}

/**
 * description 供 explain 展示（plan §6.2/§7.5）：upstream description 不可信，先去掉
 * C0 与 DEL 控制字符（换行/转义会被塞进宿主 UI 与日志），再按字符数截断加 '…'。
 * 空/缺省一律返回 undefined——explain 不渲染空 description。
 */
export function truncateDescription(description: string | undefined | null): string | undefined {
  if (typeof description !== 'string') return undefined;
  const cleaned = description.replace(/[\u0000-\u001F\u007F]/g, '');
  if (cleaned.length === 0) return undefined;
  if (cleaned.length > PROXY_CAPS.descriptionChars) {
    return `${cleaned.slice(0, PROXY_CAPS.descriptionChars)}…`;
  }
  return cleaned;
}

/** 从 schema 取 required 字段名列表（只收字符串项）；没有/形状不对就空数组。 */
function extractRequired(schema: object): string[] {
  const required = (schema as Record<string, unknown>).required;
  if (!Array.isArray(required)) return [];
  return required.filter((v): v is string => typeof v === 'string');
}

/**
 * inputSchema 序列化供 explain（plan §6.2/§7.5）。超限不裁 JSON 字符串——半个 schema
 * 会教 agent 写出坏调用——而是按 plan §4.2 降级为稳定可预期的替代：
 * 必填字段名列表 `{ required: [...], truncated: true }`。undefined/非对象输入返回 undefined。
 */
export function serializeSchemaForExplain(
  schema: unknown,
): { json: string; schemaTruncated: boolean } | undefined {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return undefined;
  const full = safeStringify(schema);
  if (full !== undefined && utf8Bytes(full) <= PROXY_CAPS.argsSchemaJsonBytes) {
    return { json: full, schemaTruncated: false };
  }
  return {
    json: JSON.stringify({ required: extractRequired(schema), truncated: true }),
    schemaTruncated: true,
  };
}
