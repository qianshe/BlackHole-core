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

const common = {
  define: buildDefines(cloudBuild), bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  minify: false, sourcemap: false, legalComments: 'none', logLevel: 'warning',
};
await esbuild.build({ ...common, entryPoints: [path.join(here, 'src/bootstrap.ts')], outfile: path.join(here, 'dist/bootstrap.cjs') });
await esbuild.build({ ...common, entryPoints: [path.join(here, 'src/core-manager.ts')], outfile: path.join(here, 'dist/core-manager.cjs') });
await esbuild.build({ ...common, entryPoints: [path.join(here, 'src/core-browser.ts')], outfile: path.join(here, 'dist/core-browser.cjs') });
await esbuild.build({ ...common, entryPoints: [path.join(here, 'src/core-lifecycle.ts')], outfile: path.join(here, 'dist/core-lifecycle.cjs') });
await esbuild.build({ ...common, format: 'esm', banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }, entryPoints: [path.join(here, 'src/core-manager-cli.ts')], outfile: path.join(here, 'dist/core-manager-cli.mjs') });
await esbuild.build({ ...common, entryPoints: [path.join(here, 'src/installer-preflight.ts')], outfile: path.join(here, 'dist/installer-preflight.cjs') });
await esbuild.build({ ...common, entryPoints: [path.join(here, 'src/installer-preflight-cli.ts')], outfile: path.join(here, 'dist/installer-preflight-cli.cjs') });
const bootstrapSha256 = createHash('sha256').update(readFileSync(path.join(here, 'dist/bootstrap.cjs'))).digest('hex');
writeFileSync(path.join(here, 'dist/cloud-build.json'), JSON.stringify({ ...cloudBuild, bootstrapSha256 }, null, 2) + '\n');
console.log(`Desktop bootstrap: ${cloudBuild.environment} -> ${cloudBuild.origin}`);
