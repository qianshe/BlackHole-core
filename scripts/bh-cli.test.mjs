import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = fileURLToPath(new URL('../client/bh.py', import.meta.url));
const sid = '000000000000000000000000000000000000123';

function pythonCommand() {
  for (const command of ['python3', 'python', 'py']) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return command;
  }
  return null;
}

const python = pythonCommand();

function runBh(url, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, '--url', url, '--sessionid', sid, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function json(res, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': String(data.length),
  });
  res.end(data);
}

async function fixture() {
  const seen = [];
  let drop = null;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push(body);

    if (drop?.method === body.method && drop.remaining > 0) {
      drop.remaining--;
      req.socket.destroy();
      return;
    }

    if (body.method === 'tools/list') {
      json(res, {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools: [{
            name: 'future_tool',
            description: 'Future tool first line\nSecond line',
            inputSchema: {
              type: 'object',
              properties: {
                value: { type: 'string' },
                nested: { type: 'object' },
              },
            },
            outputSchema: { type: 'object' },
          }],
        },
      });
      return;
    }

    if (body.method === 'tools/call') {
      const structuredOnly = body.params?.arguments?.mode === 'structured';
      json(res, {
        jsonrpc: '2.0',
        id: body.id,
        result: structuredOnly
          ? { structuredContent: { ok: true, echoed: body.params.arguments } }
          : { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } },
      });
      return;
    }

    json(res, { jsonrpc: '2.0', id: body.id, result: {} });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/mcp/test`;
  return {
    url,
    seen,
    dropOnce(method) { drop = { method, remaining: 1 }; },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function runRaw(scriptPath, args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [scriptPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('a downloaded copy uses its injected url and session id, not stale env vars', { skip: !python }, async () => {
  const f = await fixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-inject-'));
  try {
    const copy = path.join(dir, 'bh.py');
    const injected = '000000000000000000000000000000000000777';
    fs.writeFileSync(copy, fs.readFileSync(script, 'utf8')
      .replace("_INJECTED_URL = ''", `_INJECTED_URL = '${f.url}'`)
      .replace("_INJECTED_SESSIONID = ''", `_INJECTED_SESSIONID = '${injected}'`));
    const r = await runRaw(copy, ['call', 'future_tool', '{}'], '', { BH_URL: 'http://127.0.0.1:9/mcp/stale', BH_SESSIONID: sid });
    assert.equal(r.code, 0, r.stderr);
    const call = f.seen.find(b => b.method === 'tools/call');
    assert.equal(call.params.arguments.sessionId, injected, 'the injected id wins over BH_SESSIONID');
  } finally {
    await f.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('non-UTF-8 stdin stops with a message; extra tools args fail before any request', { skip: !python }, async () => {
  const f = await fixture();
  try {
    const bad = await runBh(f.url, ['call', 'future_tool', '-'], Buffer.from([0x7b, 0xff, 0x7d]));
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /not valid UTF-8/);
    assert.doesNotMatch(bad.stderr, /Traceback/);
    const before = f.seen.length;
    const extra = await runBh(f.url, ['tools', 'a', 'b']);
    assert.notEqual(extra.code, 0);
    assert.match(extra.stderr, /usage: tools/);
    assert.equal(f.seen.length, before, 'no RPC for a usage error');
  } finally {
    await f.close();
  }
});

test('bh.py tools keeps the compact list and can show one tool usage schema', { skip: !python }, async () => {
  const f = await fixture();
  try {
    const list = await runBh(f.url, ['tools']);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(list.stdout.trim(), 'future_tool - Future tool first line');

    const detail = await runBh(f.url, ['tools', 'future_tool']);
    assert.equal(detail.code, 0, detail.stderr);
    const usage = JSON.parse(detail.stdout);
    assert.deepEqual(Object.keys(usage).sort(), ['description', 'inputSchema', 'name']);
    assert.equal(usage.name, 'future_tool');
    assert.equal(usage.description, 'Future tool first line\nSecond line');
    assert.equal(usage.inputSchema.properties.value.type, 'string');
  } finally {
    await f.close();
  }
});

test('bh.py call accepts empty arguments and stdin JSON for any tool name', { skip: !python }, async () => {
  const f = await fixture();
  try {
    const empty = await runBh(f.url, ['call', 'future_tool']);
    assert.equal(empty.code, 0, empty.stderr);
    assert.equal(empty.stdout.trim(), 'ok');

    const payload = {
      value: '中文 + quotes \' " + newline\nsecond',
      nested: { list: [1, true, { deep: 'value' }] },
    };
    const fromStdin = await runBh(f.url, ['call', 'future_tool', '-'], JSON.stringify(payload));
    assert.equal(fromStdin.code, 0, fromStdin.stderr);
    assert.equal(fromStdin.stdout.trim(), 'ok');

    const calls = f.seen.filter(x => x.method === 'tools/call');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].params.arguments, { sessionId: sid });
    assert.deepEqual(calls[1].params.arguments, { ...payload, sessionId: sid });
  } finally {
    await f.close();
  }
});

test('bh.py prints structuredContent when a tool returns no text content', { skip: !python }, async () => {
  const f = await fixture();
  try {
    const result = await runBh(f.url, ['call', 'future_tool', '-'], JSON.stringify({ mode: 'structured' }));
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.echoed.mode, 'structured');
    assert.equal(output.echoed.sessionId, sid);
  } finally {
    await f.close();
  }
});

test('bh.py retries a dropped read-only request but never retries an ambiguous tools/call', { skip: !python }, async () => {
  const readonly = await fixture();
  try {
    readonly.dropOnce('tools/list');
    const result = await runBh(readonly.url, ['tools']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readonly.seen.filter(x => x.method === 'tools/list').length, 2);
  } finally {
    await readonly.close();
  }

  const write = await fixture();
  try {
    write.dropOnce('tools/call');
    const result = await runBh(write.url, ['call', 'future_tool', '{}']);
    assert.notEqual(result.code, 0);
    assert.equal(write.seen.filter(x => x.method === 'tools/call').length, 1);
  } finally {
    await write.close();
  }
});
