// Bundles src/bootstrap.ts (plus the shared contracts and zod) into one
// dependency-free CommonJS file the launcher runs with a plain `node`.
// esbuild is borrowed from packages/vscode so this package adds no lockfile deps.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseBuildArgs, buildDefines } from '../vscode/build-config.mjs';
import { assertServiceBuild } from '../../scripts/environment-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../vscode/package.json'));
const esbuild = require('esbuild');
const { build: cloudBuild } = parseBuildArgs(process.argv.slice(2));
assertServiceBuild(cloudBuild);

await esbuild.build({
  define: buildDefines(cloudBuild),
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
const bootstrapSha256 = createHash('sha256').update(readFileSync(path.join(here, 'dist/bootstrap.cjs'))).digest('hex');
writeFileSync(path.join(here, 'dist/cloud-build.json'), JSON.stringify({ ...cloudBuild, bootstrapSha256 }, null, 2) + '\n');
console.log(`Desktop bootstrap: ${cloudBuild.environment} -> ${cloudBuild.origin}`);
