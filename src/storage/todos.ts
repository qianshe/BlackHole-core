import type { DatabaseSync } from 'node:sqlite';

/** One item on a session's task board — Claude Code TodoWrite vocabulary. */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Present-continuous form shown while the item is in_progress. */
  activeForm?: string;
}

export interface TaskContract {
  goal: string;
  nonGoals: string[];
  successCriteria: string[];
  verification: string[];
}

export interface TodoBoard {
  items: TodoItem[];
  contract?: TaskContract;
  updated_at: number;
}

export const TODO_LIMITS = Object.freeze({
  items: 50,
  content: 500,
  activeForm: 200,
  contractEntries: 20,
  goal: 2000,
  nonGoal: 500,
  successCriterion: 1000,
  verification: 1000,
});

const exactKeys = (row: Record<string, unknown>, allowed: readonly string[], label: string): void => {
  if (Object.keys(row).some(key => !allowed.includes(key))) throw new Error(`invalid ${label}`);
};
const boundedString = (value: unknown, max: number, label: string, trim = false): string => {
  if (typeof value !== 'string') throw new Error(`invalid ${label}`);
  const result = trim ? value.trim() : value;
  if (result.length < 1 || result.length > max) throw new Error(`invalid ${label}`);
  return result;
};
const boundedStrings = (value: unknown, maxLength: number, label: string): string[] => {
  if (!Array.isArray(value) || value.length > TODO_LIMITS.contractEntries) throw new Error(`invalid ${label}`);
  return Array.from(value, entry => boundedString(entry, maxLength, label, true));
};

export function parseTaskContract(value: unknown): TaskContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid task contract');
  const row = value as Record<string, unknown>;
  exactKeys(row, ['goal', 'nonGoals', 'successCriteria', 'verification'], 'task contract');
  return {
    goal: boundedString(row.goal, TODO_LIMITS.goal, 'task contract goal', true),
    nonGoals: boundedStrings(row.nonGoals, TODO_LIMITS.nonGoal, 'task contract non-goal'),
    successCriteria: boundedStrings(row.successCriteria, TODO_LIMITS.successCriterion, 'task contract success criterion'),
    verification: boundedStrings(row.verification, TODO_LIMITS.verification, 'task contract verification'),
  };
}

export function parseTodoItem(value: unknown): TodoItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid todo item');
  const row = value as Record<string, unknown>;
  exactKeys(row, ['content', 'status', 'activeForm'], 'todo item');
  if (typeof row.status !== 'string' || !['pending', 'in_progress', 'completed'].includes(row.status)) throw new Error('invalid todo item status');
  const activeForm = row.activeForm === undefined ? undefined : boundedString(row.activeForm, TODO_LIMITS.activeForm, 'todo active form');
  return {
    content: boundedString(row.content, TODO_LIMITS.content, 'todo content'),
    status: row.status as TodoItem['status'],
    ...(activeForm !== undefined ? { activeForm } : {}),
  };
}

export function parseTodoDocument(value: unknown): { items: TodoItem[]; contract?: TaskContract } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid task board');
  const row = value as Record<string, unknown>;
  exactKeys(row, ['items', 'contract'], 'task board');
  if (!Array.isArray(row.items) || row.items.length > TODO_LIMITS.items) throw new Error('invalid task board');
  const items = Array.from(row.items, parseTodoItem);
  if (items.filter(item => item.status === 'in_progress').length > 1) throw new Error('invalid task board');
  const contract = row.contract === undefined ? undefined : parseTaskContract(row.contract);
  return { items, ...(contract ? { contract } : {}) };
}

/**
 * The session's task board: ONE row per session holding the whole list as a
 * JSON document. `todo` write is a full-replace protocol, so a document is
 * the honest shape — no per-item rows, no sort bookkeeping. Rows are keyed by
 * the session row id (NOT the rotating key): the board survives key rotation
 * and dies with the session (revoke / retention purge).
 */
export class TodosRepo {
  constructor(
    private db: DatabaseSync,
    /** 变更门控回调：清单写入即通知（扩展侧 epoch +1）。 */
    private onChange?: (sessionId: string) => void,
  ) {}

  /** Missing row = empty board; a corrupt document reads as empty too. */
  get(sessionId: string): TodoBoard {
    const row = this.db
      .prepare('SELECT items_json, updated_at FROM session_todos WHERE session_id = ?')
      .get(sessionId) as { items_json: string; updated_at: number } | undefined;
    if (!row) return { items: [], updated_at: 0 };
    try {
      return { ...parseTodoDocument(JSON.parse(row.items_json)), updated_at: row.updated_at };
    } catch {
      return { items: [], updated_at: 0 };
    }
  }

  set(sessionId: string, items: TodoItem[], contract?: TaskContract): void {
    const document = parseTodoDocument({ items, ...(contract ? { contract } : {}) });
    this.db
      .prepare(
        `INSERT INTO session_todos (session_id, items_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET items_json = excluded.items_json, updated_at = excluded.updated_at`,
      )
      .run(sessionId, JSON.stringify(document), Date.now());
    if (this.onChange) {
      try {
        this.onChange(sessionId);
      } catch {
        /* 变更通知是附属品，绝不影响写入 */
      }
    }
  }

  /** 终止/归档会话的清账：该会话的任务板。 */
  purgeSession(sessionId: string): number {
    return Number(this.db.prepare('DELETE FROM session_todos WHERE session_id = ?').run(sessionId).changes);
  }

  /** 保留期清扫：更新时间早于截止的板（存活的会话下次 todo write 会重建）。 */
  purgeOlderThan(cutoff: number): number {
    return Number(this.db.prepare('DELETE FROM session_todos WHERE updated_at < ?').run(cutoff).changes);
  }
}
