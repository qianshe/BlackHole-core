// Install an explicitly selected VSIX flavor for the current synchronized project version.
// Usage: node scripts/install-vsix.mjs --environment test|production
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--environment'||!['test','production'].includes(args[1]))throw new Error('Usage: node scripts/install-vsix.mjs --environment test|production');
const environment=args[1], suffix=environment==='test'?'-test':'';
const vsix=path.join(ROOT,'packages','vscode',`blackhole-vscode-${version}${suffix}.vsix`);
if(!fs.existsSync(vsix)){
 console.error(`missing ${path.relative(ROOT,vsix)}`);
 console.error(`run: pnpm package:vsix${environment==='production'?':production':''}`);
 process.exit(1);
}
const code=process.platform==='win32'?'code.cmd':'code', extensionId='qianshe.blackhole-vscode';
// VS Code may keep the already-installed bytes when two local VSIX flavors share an id+version.
// Remove that exact extension first so switching flavor is deterministic; user settings/storage remain outside the extension directory.
const removed=spawnSync(code,['--uninstall-extension',extensionId],{cwd:ROOT,stdio:'inherit',shell:process.platform==='win32'});
if(removed.error)throw removed.error;
if(removed.status!==0)console.log('No existing BlackHole extension removed; continuing with clean install.');
execFileSync(code,['--install-extension',vsix,'--force'],{cwd:ROOT,stdio:'inherit',shell:process.platform==='win32'});
console.log(`installed ${environment}: ${path.basename(vsix)}`);
