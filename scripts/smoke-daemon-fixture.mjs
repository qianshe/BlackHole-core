// Hermetic test entry: exercises the real daemon without production entitlement credentials.
import {startDaemon} from '../dist/daemon.js';
const args=process.argv.slice(2), value=(flag)=>{const i=args.indexOf(flag);return i>=0?args[i+1]:undefined;};
const port=Number(value('--port')??process.env.SMOKE_PORT??process.env.BLACKHOLE_PORT);
const dbPath=value('--db')??process.env.BLACKHOLE_DB;
if(!Number.isInteger(port)||!dbPath)throw new Error('test daemon fixture requires port and BLACKHOLE_DB/--db');
const daemon=await startDaemon({port,dbPath,tunnel:'off'},line=>process.stderr.write(line+'\n'));
const stop=()=>void daemon.stop().finally(()=>process.exit(0));
process.once('SIGINT',stop);process.once('SIGTERM',stop);
