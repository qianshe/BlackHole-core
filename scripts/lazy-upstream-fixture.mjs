// Isolated lifecycle fixture: expose process start before delaying MCP handshake.
import fs from 'node:fs';
if (process.argv[2]) fs.writeFileSync(process.argv[2], String(process.pid));
await new Promise(resolve => setTimeout(resolve, 600));
await import('./fake-upstream.mjs');
