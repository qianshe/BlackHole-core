import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
const dir = process.argv[2];
if (!dir) throw new Error('missing output directory');
fs.mkdirSync(dir, { recursive: true });
const pair = generateKeyPairSync('ed25519');
fs.writeFileSync(path.join(dir, 'private.pem'), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx' });
fs.writeFileSync(path.join(dir, 'public.pem'), pair.publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx' });
