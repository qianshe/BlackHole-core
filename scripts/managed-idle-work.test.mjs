import test from 'node:test';
import assert from 'node:assert/strict';
import { assertManagedCoreIdle, assertManagedCoreUpgradeable, managedCoreUpgradeBlockers } from '../dist/lifecycle/idle-work.js';

// Pure boundary tests. Real loopback processes and signed Manager transactions
// are exercised in packages/host-runtime/test and managed-idle-acceptance.mjs.
function fixture() {
  const states = new Map([['active', 'idle'], ['archived', 'running']]);
  const deps = {
    shutdown: async () => {},
    sessionActivity: { pendingCount: 0, status: id => states.get(id) ?? 'idle' },
    sessions: { list: () => [{ id: 'active', status: 'active' }, { id: 'archived', status: 'archived' }] },
    processes: { maintenanceBusy: () => false },
    courier: { maintenanceBusy: () => false },
    livePipes: () => 0,
    webPresence: new Set(),
    confirmations: { pendingCount: () => 0 },
  };
  return { deps, states };
}
test('idle gate ignores stored sessions with no running agent, and archived session history', () => {
  const { deps } = fixture();
  assert.doesNotThrow(() => assertManagedCoreIdle(deps));
});
test('idle cached MCP protocol sessions are not active work and cannot pin Core forever', () => {
  const { deps } = fixture();
  deps.livePipes = () => 42; // cached pairs from clients that skipped DELETE
  assert.doesNotThrow(() => assertManagedCoreIdle(deps));
  deps.sessionActivity.pendingCount = 1; // actual live tool request
  assert.throws(() => assertManagedCoreIdle(deps), /active_work/);
});
test('agent running between tool calls blocks shutdown even with zero pending handlers', () => {
  const { deps, states } = fixture();
  states.set('active', 'running');
  assert.equal(deps.sessionActivity.pendingCount, 0);
  assert.throws(() => assertManagedCoreIdle(deps), /active_work/);
  states.set('active', 'idle');
  assert.doesNotThrow(() => assertManagedCoreIdle(deps), 'an explicit completed turn can become idle');
});
test('every live operation or browser presence blocks automatic and manually signed Stop', () => {
  const blockers = [
    d => { d.sessionActivity.pendingCount = 1; },
    d => { d.processes.maintenanceBusy = () => true; },
    d => { d.courier.maintenanceBusy = () => true; },
    // A cached MCP protocol is not work. Pending tools are covered above.
    d => { d.webPresence.add({}); },
    d => { d.confirmations.pendingCount = () => 1; },
  ];
  for (const apply of blockers) {
    const { deps } = fixture();
    apply(deps);
    assert.throws(() => assertManagedCoreIdle(deps), /active_work/);
  }
});
test('missing or unavailable activity collectors fail closed without fabricating idle', () => {
  for (const field of ['shutdown', 'sessionActivity', 'sessions', 'processes', 'courier', 'livePipes', 'confirmations']) {
    const { deps } = fixture();
    delete deps[field];
    assert.throws(() => assertManagedCoreIdle(deps), /activity_unknown/, field);
  }
  const { deps } = fixture();
  deps.sessions.list = () => { throw Error('session_state_unavailable'); };
  assert.throws(() => assertManagedCoreIdle(deps), /session_state_unavailable/);
});

test('passive Web presence preserves idle Core but does not prevent a selected software upgrade',()=>{
 const {deps}=fixture();deps.webPresence.add({});
 assert.throws(()=>assertManagedCoreIdle(deps),/active_work/);
 assert.doesNotThrow(()=>assertManagedCoreUpgradeable(deps));
 assert.deepEqual(managedCoreUpgradeBlockers(deps),[]);
 deps.sessionActivity.pendingCount=1;
 assert.throws(()=>assertManagedCoreUpgradeable(deps),/active_work/);
 assert.ok(managedCoreUpgradeBlockers(deps).includes('tools_running'));
});
test('product upgrade protects actual work but does not reuse the idle 60-second heuristic',()=>{
 for(const apply of [d=>d.processes.maintenanceBusy=()=>true,d=>d.courier.maintenanceBusy=()=>true,d=>d.confirmations.pendingCount=()=>1]){
  const {deps}=fixture();apply(deps);assert.throws(()=>assertManagedCoreUpgradeable(deps),/active_work/);
 }
 const {deps,states}=fixture();states.set('active','running');
 assert.throws(()=>assertManagedCoreIdle(deps),/active_work/);
 assert.doesNotThrow(()=>assertManagedCoreUpgradeable(deps));
 assert.deepEqual(managedCoreUpgradeBlockers(deps),[]);
 deps.sessionActivity.pendingCount=1;
 assert.throws(()=>assertManagedCoreUpgradeable(deps),/active_work/);
 deps.sessionActivity.pendingCount=0;
 states.set('active','idle');assert.doesNotThrow(()=>assertManagedCoreIdle(deps));
});
