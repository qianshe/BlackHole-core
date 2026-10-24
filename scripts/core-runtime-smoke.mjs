import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const layout = path.resolve(process.argv[2] ?? '');
if (!fs.existsSync(layout)) throw new Error('layout_missing');
const hostNode = process.argv[3] === '--host-node';
if (process.argv.length > (hostNode ? 4 : 3)) throw new Error('invalid_smoke_arguments');
if (hostNode && fs.existsSync(path.join(layout, 'node'))) throw new Error('host_node_layout_contains_node');
const node = hostNode ? process.execPath : path.join(layout, 'node', 'node.exe');
const daemon = path.join(layout, 'daemon', 'cli.js');
for (const file of [node, daemon, path.join(layout, 'web', 'index.html'), path.join(layout, 'host', 'bootstrap.cjs')]) if (!fs.existsSync(file)) throw new Error(`required_file_missing:${file}`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-core-smoke-'));
const home = path.join(temp, 'home'); fs.mkdirSync(home, { recursive: true });
const port = await new Promise((resolve, reject) => { const server=net.createServer(); server.once('error',reject); server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close((error)=>error?reject(error):resolve(value));}); });
if (port === 7306) throw new Error('isolated_port_required');
const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), BLACKHOLE_HOME: path.join(home, '.blackhole'), BLACKHOLE_DB: path.join(home, '.blackhole', 'blackhole.db'), BLACKHOLE_PORT: String(port), BLACKHOLE_TUNNEL: 'off' };
for (const name of Object.keys(env)) if (['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(name.toUpperCase())) delete env[name];
const child = spawn(node, [daemon, 'serve', '--port', String(port)], { cwd: layout, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stderr=''; child.stderr.on('data',(chunk)=>{stderr+=chunk.toString();});
try {
  let health;
  for(let i=0;i<120;i++){try{const response=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(500)});if(response.ok){health=await response.json();break;}}catch{} await new Promise((r)=>setTimeout(r,100));}
  if(!health) throw new Error(`smoke_ready_timeout:${stderr.slice(-2000)}`);
  if(path.resolve(health.db_path)!==path.resolve(env.BLACKHOLE_DB)) throw new Error('smoke_data_root_mismatch');
  const web=await fetch(`http://127.0.0.1:${port}/ui/`,{redirect:'manual'}); if(![200,302,401].includes(web.status)) throw new Error(`smoke_web_failed:${web.status}`);
  try { await fetch(`http://127.0.0.1:${port}/api/shutdown`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({daemon_id:health.daemon_id,start_fingerprint:health.start_fingerprint??null}),signal:AbortSignal.timeout(2000)}); } catch {}
  await new Promise((resolve)=>{const timer=setTimeout(resolve,5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  if(child.exitCode===null) throw new Error('smoke_shutdown_timeout');
  console.log(JSON.stringify({ok:true,port,daemonId:health.daemon_id,dbPathInsideIsolatedHome:true,webStatus:web.status}));
} finally {
  if(child.exitCode===null) child.kill();
  fs.rmSync(temp,{recursive:true,force:true});
}
