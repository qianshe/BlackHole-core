import { inspectInstallerReadiness, PREFLIGHT_EXIT } from './installer-preflight.ts';
// No user-supplied file paths or arbitrary Manager requests are accepted.
async function main() {
  if (process.argv.length !== 2) { process.exitCode = 44; return; }
  const result = await inspectInstallerReadiness();
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = PREFLIGHT_EXIT[result.code];
}
void main().catch(() => { process.exitCode = 44; });
