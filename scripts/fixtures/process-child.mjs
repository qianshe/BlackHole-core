import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const mode = process.argv[2] ?? 'server';
if (mode === 'stubborn') process.on('SIGTERM', () => {});
if (mode === 'exit') { process.stderr.write('最后错误\n'); process.exitCode = 7; }
else if (mode === 'write') {
  try { fs.writeFileSync(process.argv[3], 'written'); console.log('WRITE_OK'); }
  catch { console.error('WRITE_DENIED'); process.exitCode = 13; }
} else if (mode === 'environment') {
  console.log(JSON.stringify({ secret: process.env.BH_PROCESS_TEST_SECRET ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, electron: process.env.ELECTRON_RUN_AS_NODE ?? null, cwd: process.cwd(), temp: process.env.TEMP }));
} else {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end('process fixture ' + process.pid); });
  server.listen(Number(process.argv[3] ?? 0), '127.0.0.1', () => {
    console.log(JSON.stringify({ pid: process.pid, port: server.address().port, mode }));
    console.log('Ready 中文'); console.error('non-fatal warning');
    if (mode === 'watch') {
      let count = 0;
      setInterval(() => { process.stdout.write('watch tick ' + (++count) + ' 中文持续输出\n'); if (count % 10 === 0) process.stderr.write('watch warning ' + count + '\n'); }, 50);
    }
    if (mode === 'tree' || mode === 'parent-exit') {
      if (mode === 'parent-exit') setTimeout(() => process.exit(23), 300);
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'server'], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
      child.on('error', error => { console.error(error); process.exitCode = 1; server.close(); });
    }
  });
  server.on('error', error => { console.error(error.code); process.exitCode = 1; });
}
