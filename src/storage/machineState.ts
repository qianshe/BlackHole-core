import type { DatabaseSync } from 'node:sqlite';

/**
 * Machine-scoped persisted state (single-row key/value). Currently holds the
 * MCP access-token override set from the extension's settings page: it must
 * survive daemon restarts, unlike the derived default which does.
 */
export class MachineStateRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM machine_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO machine_state (key, value, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, value, Date.now());
  }
}
