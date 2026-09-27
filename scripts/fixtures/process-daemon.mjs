// Isolated test daemon. Never loads the operator's DB, proxies, semantic credentials or tunnels.
import fs from 'node:fs';
import path from 'node:path';
import { startDaemon } from '../../dist/daemon.js';
const root = fs.realpathSync(process.env.BH_PROCESS_TEST_ROOT);
const daemon = await startDaemon({ port: Number(process.env.BH_PROCESS_TEST_PORT), dbPath: path.join(root, 'fixture.db'),
  tunnel: 'off', semantic: 'off', skillsDir: undefined, proxyConfigPath: path.join(root, 'missing-proxies.yaml'), execTimeoutMs: 1000 }, () => {});
process.on('message', message => {
  if (message === 'stop') void daemon.stop().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  else if (message?.action === 'expire') {
    const row = daemon.deps.sessions.get(message.id);
    if (row) daemon.deps.sessions['db'].prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Date.now() - 1, row.id);
    process.send?.({ expired: message.id });
  }
});
process.send?.({ ready: true });
