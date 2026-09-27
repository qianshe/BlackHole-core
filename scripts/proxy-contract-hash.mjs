#!/usr/bin/env node
// `proxy` 宿主契约 golden 断言（plan §3.3）：默认 --check 比对 dist 指纹与
// src/proxy/contract.hash；--update 显式刷新 golden（必须伴随 §3.3 加法评审）。
import fs from 'node:fs';
import { proxyContractFingerprint, PROXY_TOOL_NAME } from '../dist/proxy/contract.js';

const GOLDEN = new URL('../src/proxy/contract.hash', import.meta.url);
const fingerprint = proxyContractFingerprint();

if (process.argv.includes('--update')) {
  fs.writeFileSync(GOLDEN, fingerprint + '\n');
  console.log(`contract.hash updated: ${fingerprint} (${PROXY_TOOL_NAME})`);
  process.exit(0);
}

const golden = fs.existsSync(GOLDEN) ? fs.readFileSync(GOLDEN, 'utf8').trim() : '';
if (golden !== fingerprint) {
  console.error(`CONTRACT HASH MISMATCH for "${PROXY_TOOL_NAME}"`);
  console.error(`  golden:     ${golden || '(missing)'}`);
  console.error(`  dist build: ${fingerprint}`);
  console.error('The host contract changed. This requires the §3.3 additive-review process:');
  console.error('run `node scripts/proxy-contract-hash.mjs --update` ONLY together with that review.');
  process.exit(1);
}
console.log(`CONTRACT HASH OK (${PROXY_TOOL_NAME}): ${fingerprint}`);
