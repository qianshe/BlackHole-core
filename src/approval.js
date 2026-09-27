import readline from 'node:readline';

/**
 * Out-of-band human approval. Reads directly from the daemon's stdin — it does
 * NOT go through the MCP connection, so the requesting web AI cannot forge or
 * answer its own approval. Requests are queued (one prompt at a time).
 *
 * A human types: y (allow once) / n (deny) / a (always — allow future commands
 * in the same category without asking). Default on empty input or timeout: DENY.
 */
export class ApprovalBroker {
  constructor({ timeoutMs = 180000, alwaysCap = 20 } = {}) {
    this.timeoutMs = timeoutMs;
    this.always = new Set();
    this.queue = Promise.resolve();
    this.rl = null;
    this._closed = false;
  }

  _ensureLine() {
    if (!this.rl) {
      if (!process.stdin.isTTY) throw new Error('stdin is not a TTY — cannot ask for human approval; run the daemon in an interactive terminal or set BH_MODE=auto');
      this.rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    }
    return this.rl;
  }

  /** @returns {Promise<boolean>} approved? */
  ask({ category, reason, command }) {
    if (this._closed) return Promise.resolve(false);
    if (this.always.has(category)) return Promise.resolve(true);
    this.queue = this.queue.then(() => this._askNow({ category, reason, command }));
    return this.queue;
  }

  _askNow({ category, reason, command }) {
    let rl;
    try { rl = this._ensureLine(); } catch (e) { return Promise.resolve().then(() => { throw e; }); }
    const q = [
      '',
      '===== 需要人工审核 (human approval required) =====',
      `category : ${category}`,
      `reason   : ${reason}`,
      `command  : ${command}`,
      'approve? [y]es  [n]o  [a]lways-category   (default n):',
      '>> ',
    ].join('\n');
    return new Promise((resolve) => {
      let done = false;
      const finish = (v, note) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (note) process.stderr.write(note + '\n');
        resolve(v);
      };
      const timer = setTimeout(() => finish(false, `[approval timeout ${this.timeoutMs}ms -> denied]`), this.timeoutMs);
      rl.question(q, (ans) => {
        const a = String(ans || '').trim().toLowerCase();
        if (a === 'y' || a === 'yes') return finish(true);
        if (a === 'a' || a === 'always') {
          if (this.always.size < 20) this.always.add(category);
          return finish(true, `[always: category "${category}" auto-approved for this daemon process]`);
        }
        finish(false);
      });
    });
  }

  close() {
    this._closed = true;
    if (this.rl) this.rl.close();
    this.rl = null;
  }
}
