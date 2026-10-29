import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { atomicActivity } from '../storage/activity.js';

export interface CourierImportResult {
  status: 'imported' | 'skipped' | 'failed';
  imported: number;
  /** skipped / failed 时的原因：no_file、table_not_empty、unreadable、bad_shape、insert_failed。 */
  reason?: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);

/**
 * 把旧的 `courier-messages.json` 一次性导入 `courier_messages` 表（表必须已由 `ensureCourierMessagesTable` 建好）。
 * 只在表为空时导入；整批放在一个保存点里，任何一步失败都回滚、保留原文件、返回 failed，
 * 调用方据此以空表继续启动。导入成功后把文件改名为 `.migrated`（不删，便于回退）。
 * 原有的 rev 原样保留，缺失或非法的给 0：两者都小于 FeedLog 的起始值，只会出现在 full / history 读取里。
 */
export function importCourierMessagesJson(db: DatabaseSync, file: string, log?: (line: string) => void): CourierImportResult {
  if (!fs.existsSync(file)) return { status: 'skipped', imported: 0, reason: 'no_file' };
  if (db.prepare('SELECT 1 FROM courier_messages LIMIT 1').get()) return { status: 'skipped', imported: 0, reason: 'table_not_empty' };

  let raw: { sessions?: Record<string, unknown> };
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof raw;
  } catch (e) {
    log?.(`courier: message log unreadable, starting empty (${(e as Error).message})`);
    return { status: 'failed', imported: 0, reason: 'unreadable' };
  }
  if (!raw || typeof raw !== 'object' || (raw.sessions !== undefined && (raw.sessions === null || typeof raw.sessions !== 'object' || Array.isArray(raw.sessions)))) {
    log?.('courier: message log has an unexpected shape, starting empty');
    return { status: 'failed', imported: 0, reason: 'bad_shape' };
  }

  const insert = db.prepare(`INSERT OR IGNORE INTO courier_messages
    (id, session_id, kind, text, at, status, site, target_id, conversation_key, code, message, model, images, turn, segment, message_id, question_json, rev)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let imported = 0;
  try {
    atomicActivity(db, () => {
      for (const [sessionId, list] of Object.entries(raw.sessions ?? {})) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          // 与旧加载代码同一个判断：没有文本的条目直接丢弃
          if (!item || typeof item !== 'object' || typeof (item as { text?: unknown }).text !== 'string') continue;
          const m = item as Record<string, unknown>;
          const rev = int(m.rev);
          const info = insert.run(
            str(m.id) ?? randomUUID(), sessionId, str(m.kind) ?? 'agent', m.text as string, int(m.at) ?? 0, str(m.status) ?? 'reply',
            str(m.site), str(m.targetId), str(m.conversationKey), str(m.code), str(m.message), str(m.model),
            int(m.images), int(m.turn), str(m.segment), str(m.messageId),
            m.question ? JSON.stringify(m.question) : null, rev !== null && rev >= 0 ? rev : 0,
          );
          imported += Number(info.changes);
        }
      }
    });
  } catch (e) {
    log?.(`courier: message log import failed, starting empty (${(e as Error).message})`);
    return { status: 'failed', imported: 0, reason: 'insert_failed' };
  }

  try {
    fs.renameSync(file, `${file}.migrated`);
  } catch (e) {
    // 已导入成功。改名失败不影响正确性：下次启动表非空，会跳过导入，不会重复。
    log?.(`courier: message log imported but not renamed (${(e as Error).message})`);
  }
  log?.(`courier: imported ${imported} message(s) from the JSON log`);
  return { status: 'imported', imported };
}
