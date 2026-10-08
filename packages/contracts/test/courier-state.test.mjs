import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { courierGenerating } from '../dist/courier-state.js';
const partial = { kind: 'agent', status: 'streaming' };
const sent = { kind: 'user', status: 'sent' };
test('explicit turn end unlocks send without altering retained partial content', () => {
  const messages = [sent, partial];
  assert.equal(courierGenerating({ turnState: 'done', busy: true }, messages), false);
  assert.equal(courierGenerating({ turnState: 'stopped' }, messages), false);
  assert.equal(messages[1].status, 'streaming');
});
test('running turn stays generating between tool calls even with final text segments', () => {
  assert.equal(courierGenerating({ turnState: 'running', busy: false }, [{ kind: 'agent', status: 'reply' }]), true);
});
test('unknown generation state is not completed merely because a reply exists', () => {
  assert.equal(courierGenerating({ busy: true }, [{ kind: 'agent', status: 'reply' }]), true);
  assert.equal(courierGenerating({ busy: false }, [sent, partial]), true);
});
test('old streaming fragments do not lock a subsequent user turn; failed sends do not hide live work', () => {
  assert.equal(courierGenerating({ busy: false }, [partial, sent, { kind: 'agent', status: 'reply' }]), false);
  assert.equal(courierGenerating({ busy: false }, [partial, { kind: 'user', status: 'failed' }]), true);
});
test('webview serialized function is standalone and applies the same terminal-state rule', () => {
  const fn = vm.runInNewContext('(' + courierGenerating.toString() + ')');
  assert.equal(fn({ turnState: 'done' }, [sent, partial]), false);
  assert.equal(fn({ turnState: 'running' }, []), true);
});
