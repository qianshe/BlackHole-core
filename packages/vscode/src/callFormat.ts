import type { CallRow, ConfirmationInfo } from './controlApi';
import { toolCallDisplay } from './callDisplay';

// CSI escape sequences: ESC [ ... final-byte. Built via String.fromCharCode so
// the literal ESC byte never appears in source (a raw \x1b in a regex breaks
// some editors/tools). Covers colors, cursor moves, clears, etc.
const CSI = new RegExp(
  String.fromCharCode(27) + '\\[[0-9;?]*[ -/]*[@-~]',
  'g',
);

export function stripAnsi(text: string): string {
  return text.replace(CSI, '');
}

/** One-line command summary for a call card header. */
export function commandSummary(call: CallRow): string {
  return toolCallDisplay(call.tool, call.args_json).summary;
}

/** Human-facing argument detail. Never returns raw JSON. */
export function argumentDetails(call: CallRow): string {
  return toolCallDisplay(call.tool, call.args_json).details;
}

/** Human-readable result body for the expanded card (ANSI-stripped). */
export function resultBody(call: CallRow): string {
  if (!call.result_summary) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.result_summary);
  } catch {
    // 旧数据：截断发生在 JSON 中间的残缺文本，原样展示
    return stripAnsi(call.result_summary);
  }
  // daemon 存证超限的信封：明示截断，而不是展示残缺 JSON 假装完整
  const t = parsed as { truncated?: boolean; preview?: string };
  if (t.truncated && typeof t.preview === 'string') {
    return stripAnsi(t.preview) + '\n\n…… 结果已截断（存证上限 32KB）——完整输出已实时交付 agent。';
  }
  // editor tools wrap as { result: { message, isError } }
  const r = parsed as { result?: { message?: string }; stdout?: string; stderr?: string; message?: string };
  if (r.result && typeof r.result.message === 'string') {
    return stripAnsi(r.result.message);
  }
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
    const out = [r.stdout ?? '', r.stderr ? `[stderr]\n${r.stderr}` : ''].filter(Boolean).join('\n');
    return stripAnsi(out) || '(无输出)';
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (typeof o.reason === 'string') return stripAnsi(o.reason);
    if (typeof o.message === 'string') return stripAnsi(o.message);
    if (call.tool === 'skill' && o.kind === 'library' && Array.isArray(o.skills)) {
      const named = (entry: unknown): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).name === 'string';
      const skills = o.skills.filter(named);
      const issues = Array.isArray(o.issues) ? o.issues.filter(named) : [];
      const label = (entry: Record<string, unknown>): string =>
        `${entry.name}${typeof entry.source === 'string' ? ` (${entry.source})` : ''}`;
      const incomplete = o.complete === false || skills.length !== o.skills.length
        || (Array.isArray(o.issues) && issues.length !== o.issues.length);
      const heading = issues.length ? `可用 Skill：${skills.length} 个；存在 ${issues.length} 个配置问题`
        : incomplete ? 'Skill 列表不完整，请查看工具响应。'
        : skills.length ? `可用 Skill：${skills.length} 个` : '暂无可用 Skill。';
      return stripAnsi([heading, ...skills.map(label), ...issues.map(issue =>
        `${label(issue)}：${typeof issue.reason === 'string' ? issue.reason : '技能不可用'}`)].join('\n'));
    }
    if (typeof o.status === 'string') {
      const parts = [o.status, typeof o.state === 'string' ? o.state : '', typeof o.processId === 'string' ? o.processId : '', typeof o.exitCode === 'number' ? `exit ${o.exitCode}` : ''].filter(Boolean);
      return stripAnsi(parts.join(' · '));
    }
    if (typeof o.command === 'string') {
      const parts = [o.command, typeof o.updated === 'number' ? `更新 ${o.updated} 项` : '', typeof o.total === 'number' ? `共 ${o.total} 项` : ''].filter(Boolean);
      return stripAnsi(parts.join(' · '));
    }
  }
  return '(已完成)';
}

/**
 * Line-change stats (+added / -removed) for editor write operations, parsed
 * out of the result JSON. Returns null for non-writes (view/pwsh/todo/...)
 * and for anything without a well-formed diff payload, so callers can skip
 * rendering the badge entirely.
 */
export function resultDiff(call: CallRow): { added: number; removed: number } | null {
  if (!call.result_summary) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.result_summary);
  } catch {
    return null;
  }
  const d = (parsed as { result?: { diff?: { added?: unknown; removed?: unknown } } }).result?.diff;
  if (!d || typeof d.added !== 'number' || typeof d.removed !== 'number') return null;
  return { added: d.added, removed: d.removed };
}

/**
 * A call blocked on operator approval ('awaiting'; or 'completed' from the
 * legacy immediate-return flow) whose args_hash matches a still-pending
 * confirmation. Surface the approval banner for it in the sidebar.
 */
export function pendingConfirmationFor(call: CallRow, pending: ConfirmationInfo[]): ConfirmationInfo | undefined {
  if (call.status !== 'awaiting' && call.status !== 'completed') return undefined;
  return pending.find((c) => c.args_hash === call.args_hash);
}
