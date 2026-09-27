import test from 'node:test';
import { toolNames } from './fixtures/tool-names.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const src = fs.readFileSync(new URL('../packages/vscode/src/callDisplay.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} }; vm.runInNewContext(js, { module, exports: module.exports, require: name => name === './toolNames' ? toolNames : require(name), console });
const { toolCallDisplay } = module.exports;
const show = (tool, args) => toolCallDisplay(tool, JSON.stringify(args));

test('historical editor calls retain semantic formatting without public aliases', () => {
  for (const operation of [{ command: 'view', view_range: [1, 3] }, { command: 'create', content: 'x' }, { command: 'str_replace', old_text: 'a', new_text: 'b' }, { command: 'insert', line: 1, content: 'x' }, { command: 'delete' }]) {
    const args = { path: 'src/file.ts', operation };
    assert.deepEqual(show(toolNames.LEGACY_WORKSPACE_FILE_TOOL, args), show('editor', args));
  }
});

test('all built-in tools render intent without raw argument JSON', () => {
  const cases = [
    ['exec',{command:'rg -n "foo" src'},'rg -n "foo" src'],
    ['todo',{command:'patch',updates:[{content:'修复 exec',status:'completed'},{content:'运行测试',status:'in_progress'}]},'更新任务 · 修复 exec → 完成'],
    ['todo',{command:'write',contract:{goal:'完成展示'},todos:[{content:'检查 Panel',status:'in_progress'}]},'写入任务清单 · 检查 Panel → 进行中'],
    ['todo',{command:'read'},'读取任务清单'],
    ['process',{command:'start',name:'vite',script:'pnpm dev'},'启动 vite · pnpm dev'],
    ['process',{command:'status',processId:'proc_1'},'查看 proc_1'],
    ['process',{command:'stop',processId:'proc_1',closeTerminal:true},'停止并关闭 proc_1'],
    ['editor',{path:'src/a.ts',operation:{command:'view',view_range:[1,20]}},'view src/a.ts L1-20'],
    ['context_search',{query:'where calls render',path:'src'},'语义搜索 @src · where calls render'],
    ['skill',{name:'code-work',path:'references/x.md'},'读取 code-work · references/x.md'],
    ['guide',{tool:'process'},'查看 process 使用说明'],
    ['guide',{workflow:'plan'},'加载 plan 工作流'],
    ['guide',{workflow:'execute-plan'},'加载 execute-plan 工作流'],
    ['guide',{workflow:'handoff'},'读取 Handoff 指导'],
    ['guide',{workflow:'review'},'加载 review 工作流'],
    ['show',{},'打开实时进度面板'],
    ['proxy',{command:'call',tool:'list_pages',argsJson:'{"options":{"limit":5}}'},'调用 list_pages · options=(对象)'],
  ];
  for (const [tool,args,expected] of cases) {
    const d = show(tool,args); assert.equal(d.summary,expected,tool); assert.ok(!d.summary.trim().startsWith('{'),tool); assert.ok(!d.details.trim().startsWith('{'),tool);
  }
});

test('unknown and malformed calls fail closed to a tool label, never raw JSON', () => {
  for (const raw of ['{"nested":{"secret":"x"}}','{broken']) { const d=toolCallDisplay('future_tool',raw); assert.equal(d.summary,'future_tool'); assert.equal(d.details,'future_tool'); }
});

test('todo details contain concrete affected items, not their data structure', () => {
  const d=show('todo',{command:'patch',updates:[{content:'A',status:'completed'},{content:'B',status:'in_progress'}]});
  assert.match(d.details,/A → 完成/); assert.match(d.details,/B → 进行中/); assert.doesNotMatch(d.details,/"content"|\{|\}/);
});

test('VS Code result formatter has no raw JSON fallback for structured results', () => {
  const source=fs.readFileSync(new URL('../packages/vscode/src/callFormat.ts',import.meta.url),'utf8');
  const parsedTail=source.slice(source.indexOf('// daemon 存证超限'));
  assert.doesNotMatch(parsedTail,/return stripAnsi\(call\.result_summary\)/);
  assert.match(parsedTail,/return '\(已完成\)'/);
});

test('guide submission display uses private metadata rather than body', () => {
  assert.equal(toolCallDisplay('guide', JSON.stringify({ workflow: 'handoff', action: 'submit', content_bytes: 12 })).summary, '提交 Handoff');
});
