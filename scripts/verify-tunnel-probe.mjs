import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { TunnelManager } = await import(pathToFileURL(fileURLToPath(new URL('../dist/tunnel/manager.js', import.meta.url))).href);

const port = 7399;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('blackhole test daemon\n');
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const proxy = process.argv[2] || undefined;
const tm = new TunnelManager(port, {
  enabled: true,
  bin: fileURLToPath(new URL('../packages/vscode/dist/daemon/cloudflared.exe', import.meta.url)),
  probeProxy: proxy,
  onEvent: (status, detail) => {
    console.log(`[event] ${status} ${JSON.stringify(detail).slice(0, 400)}`);
  },
  log: (l) => console.log('[log]', l),
});
tm.start('quick');
const finish = async (tag) => {
  console.log(`RESULT(${tag}) status=${tm.status} reason=${tm.reason ?? ''}`);
  await tm.stop();
  server.close();
  process.exit(0);
};
setTimeout(() => void finish('timeout'), 90_000);
const timer = setInterval(() => {
  if (tm.status === 'online' || tm.status === 'error' || tm.status === 'unverified') {
    clearInterval(timer);
    setTimeout(() => void finish(tm.status), 200);
  }
}, 500);
