// Bundles src/bootstrap.ts (plus the shared contracts and zod) into one
// dependency-free CommonJS file the launcher runs with a plain `node`.
// esbuild is borrowed from packages/vscode so this package adds no lockfile deps.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../vscode/package.json'));
const esbuild = require('esbuild');

await esbuild.build({
  entryPoints: [path.join(here, 'src/bootstrap.ts')],
  outfile: path.join(here, 'dist/bootstrap.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});
