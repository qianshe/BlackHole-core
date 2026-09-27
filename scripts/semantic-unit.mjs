// Local sanity harness for the semantic-search port (run: pnpm semantic:check).
// No daemon, no network: everything here is pure logic over a temp workspace.
// Intentionally NOT part of test:pack/test:posix: resolveRg probes this machine
// for ripgrep (env / PATH / dsh-bundled) — wire it into CI only once rg is
// provisioned explicitly (apt-get install ripgrep or the @vscode/ripgrep package).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getRepoMap, parseAnswer, buildToolSchemas, FINAL_FORCE_ANSWER } = await import('../dist/semantic/shared.js');
const { buildSearchPrompt } = await import('../dist/semantic/prompt.js');
const { ToolExecutor, resolveRg, globToRegex } = await import('../dist/semantic/executor.js');
const { formatResult } = await import('../dist/semantic/content.js');
const { salvageSearchEvidence, parseJsonWithRepair, salvageRestrictedExecArgs } = await import('../dist/semantic/repair.js');
const { parseToolCall, classifyError, FastContextError } = await import('../dist/semantic/brain.js');
const { computeMtimeHash, buildCacheKey, setCachedResult, getCachedResult, clearCache } = await import('../dist/semantic/cache.js');
const { resolveSemanticKey, writeKeyFile, clearKeyFile } = await import('../dist/semantic/key.js');
const { loadConfig } = await import('../dist/config.js');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-sem-'));
fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
fs.writeFileSync(path.join(ws, 'src', 'auth.ts'), 'export function verifyToken(t: string) {\n  return t.length > 3;\n}\nexport const X = 1;\n');
fs.writeFileSync(path.join(ws, 'src', 'db.ts'), 'export function connect() { return null }\n');
fs.mkdirSync(path.join(ws, 'node_modules', 'junk'), { recursive: true });
fs.writeFileSync(path.join(ws, 'node_modules', 'junk', 'x.ts'), 'verifyToken must not be found here\n');

// 1. repo map: virtual root, node_modules pruned, no fallback at depth 3
const map = getRepoMap(ws, 3);
assert.ok(map.tree.startsWith('/codebase'), 'virtual root');
assert.ok(!map.tree.includes('node_modules'), 'node_modules pruned');
assert.ok(map.tree.includes('auth.ts'), 'src files present');
assert.equal(map.depth, 3);
assert.equal(map.fellBack, false);
console.log('ok repo map');

// 2. prompt: budget knobs filled, no leftover placeholders
const prompt = buildSearchPrompt(2, 5, 7);
assert.ok(prompt.includes('at most 2 turns'), 'turns');
assert.match(prompt, /more than 5 commands/i, 'commands');
assert.ok(prompt.includes('at most 7 files'), 'results');
assert.ok(!prompt.includes('{max_'), 'no leftovers');
assert.match(prompt, /ls/, 'ls is documented');
assert.match(prompt, /glob/, 'glob is documented');
assert.doesNotMatch(prompt, /Think step-by-step/i, 'no explicit chain-of-thought request');
assert.match(prompt, /specific information gap/i, 'tool calls target observable information gaps');
assert.doesNotMatch(prompt, /SINGLE restricted_exec call in your answer/i, 'tool-call limit is scoped per research turn');
assert.match(prompt, /unchanged command/i, 'blind retry is forbidden');
assert.match(prompt, /pad the result to reach 7/i, 'weak results are not added to fill max_results');
assert.match(FINAL_FORCE_ANSWER, /verified evidence/i, 'force-answer preserves evidence gate');
assert.doesNotMatch(FINAL_FORCE_ANSWER, /even if .*complete/i, 'force-answer does not invite guessing');
console.log('ok prompt (' + prompt.length + ' chars)');

// 3. schemas
const schemas = buildToolSchemas(3);
assert.equal(schemas.length, 2);
assert.equal(schemas[0].name, 'restricted_exec');
assert.deepEqual(Object.keys(schemas[0].parameters.properties), ['command1', 'command2', 'command3']);
assert.match(schemas[0].parameters.properties.command1.description, /rg, readfile, tree, ls, or glob/);
assert.equal(schemas[1].name, 'answer');
console.log('ok schemas');

// 4. answer parsing drops escapes and non-existent files
const ans = parseAnswer(
  '<ANSWER><file path="/codebase/src/auth.ts"><range>1-3</range><range>4-4</range></file>' +
    '<file path="/codebase/../outside.ts"><range>1-1</range></file>' +
    '<file path="/codebase/src/nope.ts"><range>1-2</range></file></ANSWER>',
  ws,
);
assert.equal(ans.files.length, 1, 'only the existing in-workspace file survives');
assert.equal(ans.files[0].path, 'src/auth.ts');
assert.deepEqual(ans.files[0].ranges, [[1, 3], [4, 4]]);
console.log('ok parseAnswer');

// 5. rg (JS fallback on this machine) + virtual remap + pruning
const ex = new ToolExecutor(ws, {});
const hits = await ex.rg('verifyToken', '/codebase');
assert.ok(hits.includes('/codebase/src/auth.ts:1:'), 'path remapped: ' + hits);
assert.ok(!hits.includes('node_modules'), 'node_modules skipped');
console.log('ok rg:', hits.split('\n')[0]);

// 6. readfile / tree / glob
assert.ok(ex.readfile('/codebase/src/auth.ts', 1, 2).startsWith('1:export function'));
assert.ok(ex.tree('/codebase', 2).includes('src'));
const gl = ex.glob('**/*.ts', '/codebase', 'file');
assert.ok(gl.includes('/codebase/src/auth.ts') && !gl.includes('node_modules'), gl);
console.log('ok readfile/tree/glob');

// 7. the guard blocks escapes
for (const bad of ['../../etc/passwd', '..\\..\\Windows\\win.ini']) {
  assert.match(ex.readfile(bad), /Error/, 'escape not blocked: ' + bad);
}
console.log('ok path guard');

// 8. content embedding
const budgeted = formatResult(ans.files, { budgets: { totalMaxBytes: 49152, fileMaxBytes: 16384, lineMaxChars: 400 } });
assert.ok(budgeted.report.includes('Files:') && budgeted.report.includes('Contents:'), 'two sections');
assert.ok(budgeted.report.includes('1: export function verifyToken'), 'code body: ' + budgeted.report);
assert.equal(budgeted.truncatedFiles, 0, 'small result fits the budget untouched');
// 预算耗尽：报告尾部出现截断提示 + truncatedFiles 计数（夹具只有 4 行，
// 用极小 file 预算 + 大 ranges 触发部分嵌入后的尾部省略路径）
const tiny = formatResult(
  [{ ...ans.files[0], ranges: [[1, 3]] }],
  { budgets: { totalMaxBytes: 2048, fileMaxBytes: 60, lineMaxChars: 15 } },
);
assert.ok(tiny.truncatedFiles > 0, 'budget exhaustion is counted');
assert.ok(tiny.report.includes('result truncated'), 'the report says so out loud');
assert.ok(tiny.report.includes('use view'), 'the omission marker carries the follow-up read hint');
assert.ok(!formatResult(ans.files, { includeContent: false }).report.includes('Contents:'), 'list only');
console.log('ok content format');

// 9. salvage from prose
const sal = salvageSearchEvidence(
  'I looked at /codebase/src/db.ts plus {"type":"readfile","file":"/codebase/src/auth.ts","start_line":1,"end_line":2} and {"type":"rg","pattern":"connect\s*\(","path":"/codebase/src"}',
  ws,
);
assert.ok(sal.files.some((f) => f.path === 'src/db.ts'), 'loose path');
assert.ok(sal.files.some((f) => f.path === 'src/auth.ts' && f.ranges.length === 1), 'loose readfile');
assert.deepEqual(sal.rg_patterns, ['connect\s*\(']);
console.log('ok salvage:', sal.files.map((f) => f.path).join(', '));

// 10. tool-call parsing and JSON repair
const tc = parseToolCall('thinking [TOOL_CALLS]restricted_exec[ARGS]{"command1": {"type":"rg","pattern":"x","path":"/codebase",}}');
assert.ok(tc, 'parsed');
assert.equal(tc[1], 'restricted_exec');
assert.equal(tc[2].command1.type, 'rg');
assert.equal(tc[0], 'thinking');
assert.equal(parseJsonWithRepair('{a:1,}').a, 1);
// Keys may be bare (the repair quotes them); values must still be JSON.\nconst salvagedArgs = salvageRestrictedExecArgs('command1: {type: "rg", pattern: "p", path: "/codebase"}') as Record<string, { type: string }>;\nassert.equal(salvagedArgs.command1.type, 'rg');
console.log('ok parseToolCall/repair');

// 11. cache key sensitivity
const h1 = computeMtimeHash(ws);
const key = buildCacheKey({ query: 'q', model: 'm', maxTurns: 3, maxResults: 10, treeDepth: 3, mtimeHash: h1, excludePaths: [] });
clearCache();
setCachedResult(key, { files: [{ path: 'x', full_path: 'x', ranges: [] }] });
assert.ok(getCachedResult(key), 'hit');
assert.equal(computeMtimeHash(ws), h1, 'stable without edits');
fs.appendFileSync(path.join(ws, 'src', 'db.ts'), '// touched\n');
const h3 = computeMtimeHash(ws);
assert.notEqual(h1, h3, 'hash changes on edit');
assert.equal(getCachedResult(buildCacheKey({ query: 'q', model: 'm', maxTurns: 3, maxResults: 10, treeDepth: 3, mtimeHash: h3, excludePaths: [] })), null);
console.log('ok cache');

// 12. key chain: env > file > none, mode bits, auto gated off by default
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-home-'));
const cfg = { ...loadConfig({ dbPath: path.join(home, 'x.db') }), semanticKeyPath: path.join(home, 'semantic-key') };
let r = await resolveSemanticKey(cfg, { BLACKHOLE_SEMANTIC_KEY: 'sk-env-key-123' });
assert.equal(r.source, 'env');
writeKeyFile(cfg, 'sk-file-key-123');
assert.equal((await resolveSemanticKey(cfg, {})).source, 'file', 'env beats file');
// POSIX mode bits are advisory on Windows (NTFS ACLs decide): assert where they apply.
if (process.platform !== 'win32') assert.equal(fs.statSync(cfg.semanticKeyPath).mode & 0o077, 0o600);
clearKeyFile(cfg);
r = await resolveSemanticKey({ ...cfg, semantic: 'explicit' }, {});
assert.equal(r.source, 'none');
assert.ok(r.detail.includes('blackhole semantic <KEY>'), 'actionable hint: ' + r.detail);
r = await resolveSemanticKey({ ...cfg, semantic: 'off' }, {});
assert.equal(r.source, 'none');
assert.ok(r.detail.includes('BLACKHOLE_SEMANTIC=off'), r.detail);
console.log('ok key chain');

// 13. error classification
assert.equal(classifyError(Object.assign(new Error('boom'), { status: 429 })).code, 'RATE_LIMITED');
assert.equal(classifyError(Object.assign(new Error('boom'), { status: 401 })).code, 'AUTH_ERROR');
assert.equal(classifyError(new FastContextError('x', 'AUTH_ERROR')).code, 'AUTH_ERROR');
console.log('ok classify');

// 14. glob regex
assert.ok(globToRegex('**/*.ts').test('a/b/c.ts'));
assert.ok(!globToRegex('*.ts').test('a/c.ts'));
console.log('ok glob');

console.log('\nALL OK — search backend:', resolveRg().bin || 'JS fallback (' + resolveRg().problems.join('; ') + ')');
