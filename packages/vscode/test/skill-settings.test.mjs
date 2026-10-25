import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('daemon launch keeps custom skill overrides even when absent, and blank VS Code settings clear inherited overrides', () => {
  const source = read('../src/daemonManager.ts');
  const literal = source.match(/const env: NodeJS\.ProcessEnv = \{[\s\S]*?\n    \};/)?.[0];
  assert.ok(literal, 'execute the real launch environment expression');
  const js = ts.transpileModule(literal+'\nglobalThis.result=env;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const value of ['/missing/custom-skills', '~/.private-skills', '']) {
    const context = { process: { env: { BLACKHOLE_SKILLS_DIR: '/stale/inherited', KEEP: 'unchanged' } },
      c: { port: 7000, channelMode: 'custom', namedTunnelName: 'fixture', skillsDir: value }, spawnFingerprint: 'fixture' };
    vm.runInNewContext(js, context);
    assert.equal(context.result.BLACKHOLE_SKILLS_DIR, value);
    assert.equal(context.result.KEEP, 'unchanged');
  }
  assert.doesNotMatch(source, /skillsDir does not exist, ignoring|技能目录不存在，skill 工具将不可用/);
});

test('settings metadata describes project merge and exclusive custom replacement without implicit grants', () => {
  const property = JSON.parse(read('../package.json')).contributes.configuration.properties['blackhole.skillsDir'];
  assert.equal(property.default, '', 'blank remains the default-mode selector, not a silently persisted manual path');
  assert.match(property.description, /~\/\.agents\/skills/);
  assert.match(property.description, /merged.*project.*precedence/i);
  assert.match(property.description, /replaces only the user default, even when missing/i);
  assert.match(property.description, /only the explicit library retains keyless/i);
  assert.match(property.description, /Relative paths use the daemon launch directory/);
  assert.doesNotMatch(property.description, /in addition|Empty = the skill tool reports itself unavailable/);
});

test('skill result cards show selected skills and diagnostics instead of an ambiguous ok or empty state', () => {
  const module = { exports: {} };
  const js = ts.transpileModule(read('../src/callFormat.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require: name => {
    assert.equal(name, './callDisplay'); return { toolCallDisplay() { throw new Error('result formatting must not depend on arguments'); } };
  } });
  const format = value => module.exports.resultBody({ tool: 'skill', result_summary: JSON.stringify(value) });
  const healthy = format({ status: 'ok', kind: 'library', complete: true, count: 1, skills: [{ name: 'review', source: 'project', description: 'rules' }] });
  assert.match(healthy, /1/); assert.match(healthy, /review/); assert.match(healthy, /project/);
  const problem = format({ status: 'ok', kind: 'library', complete: true, count: 0, skills: [],
    issues: [{ name: 'broken', source: 'project', code: 'not_found', reason: 'Missing SKILL.md' }] });
  assert.match(problem, /存在.*问题/); assert.match(problem, /broken/); assert.match(problem, /Missing SKILL.md/);
  assert.notEqual(problem, 'ok'); assert.doesNotMatch(problem, /正常空|暂无/);
  assert.match(format({ status: 'ok', kind: 'library', complete: true, skills: [], count: 0 }), /暂无可用 Skill/);
  assert.match(format({ status: 'unreadable', reason: 'Library unreadable' }), /Library unreadable/);
  assert.equal(format({ status: 'ok', kind: 'library', skills: [null, { name: 42 }], issues: [null] }).includes('[object Object]'), false);
  assert.equal(format({ status: 'ok', kind: 'document' }), 'ok', 'other result kinds keep their existing formatter');
});
