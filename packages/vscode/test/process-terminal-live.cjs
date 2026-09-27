// Runs ONLY inside the dedicated minimal test extension, never the operator's BlackHole extension.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const vscode = require('vscode');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.run = async () => {
  const input = JSON.parse(fs.readFileSync(process.env.BH_PROCESS_VSCODE_INPUT, 'utf8'));
  const { ProcessTerminalController } = require(input.controller);
  const { Client } = require(input.sdkClient);
  const { StreamableHTTPClientTransport } = require(input.sdkTransport);
  let controller, client;
  const until = async (read, accept, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    for (;;) { const value = await read(); if (accept(value)) return value; if (Date.now() >= deadline) throw Error('VS Code condition timed out: ' + JSON.stringify(value)); await delay(100); }
  };
  const api = {
    async request(route, body) {
      const response = await fetch(input.base + '/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json(); if (!response.ok) throw Object.assign(Error(JSON.stringify(data)), { status: response.status }); return data;
    },
    processSync(body) { return this.request('/processes/sync', body); },
    processStop(body) { return this.request('/processes/stop', body); },
  };
  const mine = () => vscode.window.terminals.filter(t => t.name.startsWith('BlackHole ·'));
  try {
    // BlackHole source/installed extension MUST NOT activate in this window.
    assert.equal(vscode.extensions.getExtension('qianshe.blackhole-vscode'), undefined);
    client = new Client({ name: 'vscode-process-verifier', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(input.mcpUrl))); await client.listTools();
    const status = async processId => {
      const result = await client.callTool({ name: 'process', arguments: { sessionId: input.credential, command: 'status', processId } });
      return result.structuredContent;
    };
    controller = new ProcessTerminalController(api, { roots: () => [input.project], enabled: true }); controller.start();
    await until(async () => Promise.all(input.ids.map(status)), rows => rows.every(r => r.terminal.state === 'open'));
    assert.equal(mine().length, 3); assert.equal(new Set(mine().map(t => t.creationOptions.pty)).size, 3);
    const initialStates = await Promise.all(input.ids.map(status));
    assert.ok(initialStates.every(r => r.state === 'running')); assert.ok(initialStates.every(r => r.output.stderr.includes('non-fatal warning')));
    assert.ok(initialStates.every(r => r.output.stdout.includes('Ready 中文')));
    const health = async () => (await (await fetch(input.base + '/api/health')).json()).stats;
    const baselineRss = (await health()).rss_mb; let peakRss = baselineRss;
    const held = Date.now();
    while (Date.now() - held < input.soakMs) {
      await delay(2000);
      const states = await Promise.all(input.ids.map(status));
      assert.ok(states.every(r => r.state === 'running' && r.terminal.state === 'open'));
      assert.equal(mine().length, 3);
      peakRss = Math.max(peakRss, (await health()).rss_mb);
      assert.ok(peakRss - baselineRss < 128, 'daemon RSS grew beyond the bounded-test budget');
      assert.ok(states.every(row => Buffer.byteLength(row.output.stdout) <= 16384 && Buffer.byteLength(row.output.stderr) <= 16384));
      for (const port of input.ports) assert.equal((await fetch('http://127.0.0.1:' + port)).status, 200);
    }
    const watchTail = await status(input.ids[2]);
    if (input.soakMs >= 300000) assert.equal(watchTail.output.truncated, true, 'continuous watch output must stay bounded');
    // User closes one terminal view: the corresponding task is stopped and cannot remain hidden.
    const first = mine().find(t => t.name.endsWith(input.ids[0].slice(-8))); assert.ok(first); first.dispose();
    await until(() => status(input.ids[0]), row => row.state === 'exited' && row.terminal.state === 'closed');
    await assert.rejects(fetch('http://127.0.0.1:' + input.ports[0])); await delay(1200); assert.equal(mine().length, 2);
    // Exercise the real VS Code terminal input command, targeting this isolated window's B view only.
    const second = mine().find(t => t.name.endsWith(input.ids[1].slice(-8))); assert.ok(second); second.show(false);
    await delay(500);
    await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text: '\u0003' });
    const stopped = await until(() => status(input.ids[1]), row => row.state === 'exited');
    assert.equal((await status(input.ids[2])).state, 'running');
    assert.equal((await fetch('http://127.0.0.1:' + input.ports[2])).status, 200);
    // Choose C deterministically instead of automating QuickPick; process control,
    // terminal disposal and the close acknowledgement still use the real APIs.
    const select = controller.select;
    controller.select = async () => controller.items.find(item => item.processId === input.ids[2]);
    try { await controller.stopAndCloseSelected(); } finally { controller.select = select; }
    await until(() => status(input.ids[2]), row => row.state === 'exited' && row.terminal.state === 'closed');
    await until(async () => mine().map(t => t.name), names => names.length === 1 && !names.some(name => name.endsWith(input.ids[2].slice(-8))));
    await assert.rejects(fetch('http://127.0.0.1:' + input.ports[2]));
    assert.ok(mine().includes(second), 'ordinary Ctrl+C retains B final output');
    await delay(1200); assert.equal(mine().length, 1, 'closed A/C views must not automatically reopen');
    fs.writeFileSync(input.receipt, JSON.stringify({ ok: true, vscodeVersion: vscode.version, terminals: 3, distinctIds: input.ids,
      realOpenAcknowledgements: true, stderrRoundTrip: true, closeStoppedProcess: true,
      realCtrlCStoppedOne: true, stopAndCloseAcknowledged: true, ordinaryStopPreservedView: true,
      allProcessesStopped: true, soakMs: Date.now() - held, stoppedExitCode: stopped.exitCode }, null, 2));
  } catch (error) {
    fs.writeFileSync(input.receipt, JSON.stringify({ ok: false, error: String(error), stack: error.stack, terminals: mine().map(t => t.name) }, null, 2));
    throw error;
  } finally { controller?.dispose(); await client?.close().catch(() => {}); }
};
