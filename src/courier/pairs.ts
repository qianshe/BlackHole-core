import fs from 'node:fs';
import path from 'node:path';

/**
 * One BlackHole session ↔ one web chat. `paired`: Courier holds the binding and UIs may send;
 * `unpaired`: the user cut it (receive only until Courier pairs it again by hand).
 * Sessions without a record are either new drafts or template-direct sessions (no Courier).
 */
export type PairState = 'paired' | 'unpaired';
export interface CourierPair {
  state: PairState;
  site: string | null;
  conversationKey: string | null;
  at: number;
}
/** What UIs show for a session: `new` has a composer that opens a chat, `direct` has none. */
export type SessionLink = 'new' | 'paired' | 'unpaired' | 'direct';

export class CourierPairs {
  private readonly map = new Map<string, CourierPair>();

  constructor(private readonly file: string | null, private readonly log?: (line: string) => void) {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { pairs?: Record<string, CourierPair> };
      for (const [id, p] of Object.entries(raw.pairs ?? {})) {
        if (p && (p.state === 'paired' || p.state === 'unpaired')) {
          this.map.set(id, { state: p.state, site: p.site ?? null, conversationKey: p.conversationKey ?? null, at: Number(p.at) || 0 });
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log?.(`courier: pairs unreadable (${(e as Error).message})`);
    }
  }

  get(sessionId: string): CourierPair | undefined {
    return this.map.get(sessionId);
  }

  all(): Record<string, CourierPair> {
    return Object.fromEntries(this.map);
  }

  set(sessionId: string, state: PairState, site: string | null, conversationKey: string | null): void {
    const old = this.map.get(sessionId);
    if (old && old.state === state && old.site === site && old.conversationKey === conversationKey) return;
    this.map.set(sessionId, { state, site, conversationKey, at: Date.now() });
    this.save();
  }

  /** The session is gone (deleted/ended): drop its record for good. */
  delete(sessionId: string): boolean {
    if (!this.map.delete(sessionId)) return false;
    this.save();
    return true;
  }

  /** The UI state of a session; `draft` = never stored (no tool call, nothing sent yet). */
  link(sessionId: string, draft: boolean): SessionLink {
    const p = this.map.get(sessionId);
    if (p) return p.state;
    return draft ? 'new' : 'direct';
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, pairs: this.all() }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log?.(`courier: pairs not saved (${(e as Error).message})`);
    }
  }
}
