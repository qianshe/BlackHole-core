// Inspect the selected Node distribution without substituting the project's LICENSE.
// Hashes identify the files being packaged; they do not establish upstream provenance.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function inspectDesktopNode(executable = process.execPath) {
  const exe = fs.realpathSync(executable);
  const dir = path.dirname(exe);
  const candidates = [
    path.join(dir, 'LICENSE'),
    path.join(dir, '..', 'LICENSE'),
    path.join(dir, '..', 'share', 'doc', 'node', 'LICENSE'),
  ];
  const lic = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!lic) throw Error('desktop_node_license_missing: use a Node distribution containing its LICENSE');
  const size = fs.statSync(lic).size;
  if (size < 1 || size > 4 * 1024 * 1024) throw Error('desktop_node_license_invalid');
  const license = fs.readFileSync(lic);
  const text = license.toString('utf8');
  if (!/Node\.js/i.test(text) || !/Permission is hereby granted/.test(text)) {
    throw Error('desktop_node_license_invalid: expected Node.js distribution license');
  }
  return { exe, exeSha: sha256(fs.readFileSync(exe)), lic: fs.realpathSync(lic), licSha: sha256(license) };
}

export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { output: { type: 'string' } } });
  if (!values.output) throw Error('usage: --output FILE');
  const info = inspectDesktopNode();
  fs.writeFileSync(path.resolve(values.output), JSON.stringify(info) + '\n', { flag: 'wx' });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
