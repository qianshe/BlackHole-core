// Fake MCP upstream server（stdio transport）—— 永久测试夹具。
// 供 BlackHole 通用 proxy 的 E2E 验收使用；工具契约见各 registerTool。
// 启动：node scripts/fake-upstream.mjs（stdout 只承载 JSON-RPC，一切人类可读输出走 stderr）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// 1x1 透明 PNG（70 字节）的 base64：emit_binary 用，验证二进制 content block 的转发
const FAKE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = new McpServer(
  { name: 'fake-upstream', version: '1.0.0' },
  {
    // 带可检索标记：验证 BlackHole 不把 upstream instructions 注入 guide
    instructions: 'FAKE-UPSTREAM-INSTRUCTIONS: this text must never be injected into any guide.',
  },
);

// 模块级非幂等计数器：进程重启即清零 —— 测试断言 crash 后不自动重放
let bumpCount = 0;

// readOnlyHint 只是提示，上游 annotation 不该被 proxy 当作授权依据
server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Echoes the payload back as JSON. Pass nothing to get {"payload":"ok"}.',
    inputSchema: { payload: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const payload = args?.payload ?? 'ok';
    return { content: [{ type: 'text', text: JSON.stringify({ payload }) }] };
  },
);

server.registerTool(
  'slow',
  {
    title: 'Slow',
    description: 'Sleeps ms milliseconds (default 5000) then returns. For timeout tests.',
    inputSchema: { ms: z.number().int().optional() },
  },
  async (args) => {
    const ms = args?.ms ?? 5000;
    await sleep(ms);
    return { content: [{ type: 'text', text: `slept ${ms}ms` }] };
  },
);

server.registerTool(
  'crash_now',
  {
    title: 'Crash Now',
    description: 'Exits this process immediately with code 70. For child crash tests.',
    inputSchema: {},
  },
  async () => {
    process.exit(70);
  },
);

server.registerTool(
  'bump_counter',
  {
    title: 'Bump Counter',
    description: 'Increments an in-process counter and returns it. Non-idempotent: resets on restart.',
    inputSchema: {},
  },
  async () => {
    bumpCount += 1;
    return { content: [{ type: 'text', text: JSON.stringify({ count: bumpCount }) }] };
  },
);

// ── 浏览器语义夹具（M3）：名字对齐 chrome-devtools-mcp，行为为纯回显 ——
// 供 browser profile 的 domain policy / fill 脱敏 E2E 使用，不驱动真浏览器。
server.registerTool(
  'navigate_page',
  {
    title: 'Navigate Page (fixture)',
    description: 'Fixture navigation: echoes the target url. Browser profile policy tests.',
    inputSchema: { url: z.string().min(1) },
  },
  async (args) => ({ content: [{ type: 'text', text: `navigated: ${args?.url ?? ''}` }] }),
);

server.registerTool(
  'fill',
  {
    title: 'Fill (fixture)',
    description: 'Fixture form input: echoes uid. Browser profile redaction tests use value.',
    inputSchema: { uid: z.string().min(1), value: z.string() },
  },
  async (args) => ({ content: [{ type: 'text', text: `filled ${args?.uid ?? ''}` }] }),
);

server.registerTool(
  'evaluate_script',
  {
    title: 'Evaluate Script (fixture)',
    description: 'Fixture script evaluation: returns the script length.',
    inputSchema: { script: z.string().min(1) },
  },
  async (args) => ({ content: [{ type: 'text', text: `evaluated:${String(args?.script ?? '').length}` }] }),
);

server.registerTool(
  'emit_binary',
  {
    title: 'Emit Binary',
    description: 'Returns a hardcoded 1x1 transparent PNG as an image content block. kind must be "png".',
    inputSchema: { kind: z.enum(['png']) },
  },
  async () => ({
    content: [{ type: 'image', data: FAKE_PNG_BASE64, mimeType: 'image/png' }],
  }),
);

server.registerTool(
  'schema_heavy',
  {
    title: 'Schema Heavy',
    description: 'Has required/optional described fields. For explain/argsExample tests.',
    inputSchema: {
      required_str: z.string().min(1).describe('Required non-empty string.'),
      required_int: z.number().int().describe('Required integer.'),
      optional_note: z.string().optional().describe('Optional note.'),
    },
  },
  async (args) => ({
    content: [{ type: 'text', text: JSON.stringify(args) }],
  }),
);

// 环境探针：验证 proxy 把 env.set 的 `${ENV_VAR}` 引用**展开**后注入 child。
// 只回长度/present，不回值——注入值本身会被 proxy 当作 secret 掩码，回值无法区分
// "展开成功" 与 "模板串原样注入"（两者都会被掩码），长度才是判别信号。
server.registerTool(
  'env_probe',
  {
    title: 'Env Probe',
    description: 'Reports {name, present, length} for one environment variable. For proxy env-injection tests.',
    inputSchema: { name: z.string().min(1) },
  },
  async (args) => {
    const value = process.env[args?.name ?? ''];
    return { content: [{ type: 'text', text: JSON.stringify({ name: args?.name ?? '', present: value !== undefined, length: value === undefined ? 0 : value.length }) }] };
  },
);

// 必须写在 connect 之前：stderr 脱敏负向测试检索这行标记（stdout 协议外零输出，故只能走 stderr）。
// 打印的是**被注入的** env secret（存在时）：这才是"我们自己的机密经 upstream stderr 泄漏"的真实场景。
const injectedSecret = process.env.E2E_SECRET_VALUE ?? 'sk-fake-secret-123';
process.stderr.write(`FAKE-UPSTREAM-STDERR-MARKER startup token=${injectedSecret}\n`);

const transport = new StdioServerTransport();
// stdin 关闭（proxy 退出）时确保进程退出，避免 Windows 上遗留孤儿 upstream 子进程
transport.onclose = () => process.exit(0);

await server.connect(transport);
