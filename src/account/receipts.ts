import fs from 'node:fs';
import path from 'node:path';
import { receiptName, validReceipt, type Receipt, type ReceiptPort } from './cloud-auth-client.js';

/** Login/logout receipts as user-only JSON files; they hold no secret (the token lives in the OS store). */
export function fileReceiptPort(dir: string, origin: string): ReceiptPort {
  const ensure = () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    async list() {
      ensure();
      const out: Receipt[] = [];
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const value = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as unknown;
          if (validReceipt(value, origin) && receiptName(value, origin) === name) out.push(value);
        } catch {
          /* skip unreadable */
        }
      }
      return out;
    },
    async put(value) {
      ensure();
      const file = path.join(dir, receiptName(value, origin));
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    async remove(value) {
      fs.rmSync(path.join(dir, receiptName(value, origin)), { force: true });
    },
  };
}
