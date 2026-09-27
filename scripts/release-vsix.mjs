// One-command local release: bump version everywhere, then build/package the VSIX.
// Usage: pnpm release:vsix [patch|minor|major|X.Y.Z]
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bump = path.join(ROOT, 'scripts', 'bump-version.mjs');
const pack = path.join(ROOT, 'scripts', 'package-vsix.mjs');
const target = (process.argv[2] ?? 'patch').trim();

execFileSync(process.execPath, [bump, target], { cwd: ROOT, stdio: 'inherit' });
execFileSync(process.execPath, [pack, '--environment', 'production'], { cwd: ROOT, stdio: 'inherit' });
