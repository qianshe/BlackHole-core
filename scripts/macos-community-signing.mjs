// Ad-hoc signing needs no Apple account. It is not Developer ID or notarization.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function signCommunityMacBundle(app, { run = spawnSync } = {}) {
 if (!path.isAbsolute(app) || !app.endsWith('.app') || fs.lstatSync(app).isSymbolicLink()) throw Error('macos_app_path_invalid');
 const code = path.join(app, 'Contents/MacOS');
 const pinned = ['bootstrap/node.exe', 'bootstrap/node-LICENSE', 'bootstrap/core-manager-cli.mjs', 'bootstrap/trust.json', 'seed/core.zip'];
 const before = pinned.map(file => hash(path.join(code, file)));
 // Never use --deep when signing: it would rewrite the pinned Node binary.
 for (const args of [
  ['--force', '--sign', '-', '--timestamp=none', app],
  ['--verify', '--deep', '--strict', app],
 ]) {
  const result = run('codesign', args, { encoding: 'utf8' });
  if (result.status !== 0) throw Error('macos_adhoc_signing_failed:' + (result.error?.message ?? result.stderr ?? 'unknown'));
 }
 for (const [i,file] of pinned.entries()) if (hash(path.join(code,file)) !== before[i]) throw Error('macos_pinned_payload_changed:' + file);
 return { identity: 'ad-hoc', developerId: false, notarized: false, verified: true, pinnedPayloadUnchanged: true };
}
