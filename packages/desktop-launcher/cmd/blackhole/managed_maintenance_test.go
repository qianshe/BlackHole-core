package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"blackhole/desktop-launcher/internal/coremanager"
)

type fakeMaintenanceManager struct {
	start        *coremanager.StartState
	maintainErr  error
	result       coremanager.MaintenanceResult
	records      []coremanager.MaintenanceRecord
	reconcileErr error

	maintainCalls  int
	reconcileCalls int
	heartbeats     int
	detaches       int
	lastRevision   *int
	onMaintain     func()
}

func (f *fakeMaintenanceManager) Maintain(ctx context.Context, host coremanager.Host, prior coremanager.Attachment, port int, operation, id string, confirmed bool, revision *int) (coremanager.MaintenanceResult, error) {
	f.maintainCalls++
	f.lastRevision = revision
	if f.onMaintain != nil {
		f.onMaintain()
	}
	return f.result, f.maintainErr
}
func (f *fakeMaintenanceManager) InspectMaintenances(ctx context.Context) ([]coremanager.MaintenanceRecord, error) {
	return f.records, nil
}
func (f *fakeMaintenanceManager) ReconcileMaintenance(ctx context.Context, id, fingerprint string, confirmed bool) error {
	f.reconcileCalls++
	return f.reconcileErr
}
func (f *fakeMaintenanceManager) InspectStart(ctx context.Context) (*coremanager.StartState, error) {
	return f.start, nil
}
func (f *fakeMaintenanceManager) Heartbeat(ctx context.Context, handle coremanager.Handle, port int) (coremanager.Lease, error) {
	f.heartbeats++
	return coremanager.Lease{LeaseID: handle.LeaseID, InstanceID: handle.InstanceID, DaemonID: handle.DaemonID, DataRootID: handle.DataRootID, DescriptorHash: handle.DescriptorHash}, nil
}
func (f *fakeMaintenanceManager) Detach(ctx context.Context, handle coremanager.Handle) error {
	f.detaches++
	return nil
}

type fakePrompts struct {
	confirm bool
	infos   []string
	errors  []string
}

func (p *fakePrompts) Confirm(title, text string) bool { return p.confirm }
func (p *fakePrompts) Info(title, text string)         { p.infos = append(p.infos, text) }
func (p *fakePrompts) Error(title, text string)        { p.errors = append(p.errors, text) }

const testDescriptor = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const testDataRoot = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func testAttachment(leaseID string) coremanager.Attachment {
	receipt := coremanager.Receipt{DaemonID: "daemon-1", DaemonVersion: "1.0.0", StartFingerprint: "fp-1", DescriptorHash: testDescriptor, DataRootID: testDataRoot, RuntimeID: "node", BuildID: "build-1", LocalURL: "http://127.0.0.1:18306/ui/"}
	lease := coremanager.Lease{SchemaVersion: 1, LeaseID: leaseID, ClientID: "desktop:test", InstanceID: "11111111-1111-4111-8111-111111111111", Kind: "desktop", RuntimeID: "node", BuildID: "build-1", DescriptorHash: testDescriptor, DataRootID: testDataRoot, DaemonID: "daemon-1"}
	return coremanager.Attachment{Receipt: receipt, Lease: lease}
}

func testStart() *coremanager.StartState {
	attachment := testAttachment("22222222-2222-4222-8222-222222222222")
	return &coremanager.StartState{SchemaVersion: 1, Status: "ready", Port: 18306, StartFingerprint: "fp-1", DescriptorHash: testDescriptor, DataRootID: testDataRoot, Receipt: &attachment.Receipt}
}

func testCoordinator(fake *fakeMaintenanceManager, prompts *fakePrompts, hooks maintenanceHooks) (*maintenanceCoordinator, *leaseKeeper) {
	host := coremanager.Host{ClientID: "desktop:test", InstanceID: "11111111-1111-4111-8111-111111111111", Kind: "desktop", Version: "1.0.0"}
	keeper := newLeaseKeeper(fake, host, testAttachment("22222222-2222-4222-8222-222222222222"), 18306, nil)
	coordinator := newMaintenanceCoordinator(fake, keeper, prompts, hooks)
	coordinator.newID = func() string { return "33333333-3333-4333-8333-333333333333" }
	return coordinator, keeper
}

func TestCoordinatorTargetChangeBlocksMaintenance(t *testing.T) {
	fake := &fakeMaintenanceManager{start: testStart()}
	fake.start.StartFingerprint = "another-incarnation"
	prompts := &fakePrompts{confirm: true}
	coordinator, _ := testCoordinator(fake, prompts, maintenanceHooks{})
	if coordinator.Run(context.Background(), "stop", nil) {
		t.Fatal("target change must not complete")
	}
	if fake.maintainCalls != 0 || len(prompts.errors) != 1 || !strings.Contains(prompts.errors[0], "maintenance_target_changed") {
		t.Fatalf("calls=%d errors=%v", fake.maintainCalls, prompts.errors)
	}
}

func TestCoordinatorCancelSendsNothing(t *testing.T) {
	fake := &fakeMaintenanceManager{start: testStart()}
	prompts := &fakePrompts{confirm: false}
	coordinator, keeper := testCoordinator(fake, prompts, maintenanceHooks{})
	if coordinator.Run(context.Background(), "restart", nil) || fake.maintainCalls != 0 {
		t.Fatal("cancelled confirmation must not dispatch")
	}
	keeper.mu.Lock()
	paused := keeper.paused
	keeper.mu.Unlock()
	if paused {
		t.Fatal("cancel must not pause the keeper")
	}
}

func TestCoordinatorStopPausesKeeperAndConsumesLease(t *testing.T) {
	fake := &fakeMaintenanceManager{start: testStart(), result: coremanager.MaintenanceResult{Operation: "stop", Stopped: true, RequestID: "33333333-3333-4333-8333-333333333333"}}
	prompts := &fakePrompts{confirm: true}
	stopped, pausedDuring := false, false
	var coordinator *maintenanceCoordinator
	var keeper *leaseKeeper
	coordinator, keeper = testCoordinator(fake, prompts, maintenanceHooks{OnStopped: func() { stopped = true }})
	fake.onMaintain = func() {
		keeper.mu.Lock()
		pausedDuring = keeper.paused
		keeper.mu.Unlock()
	}
	if !coordinator.Run(context.Background(), "stop", nil) || !stopped || !pausedDuring {
		t.Fatalf("completed/stopped/paused = %v/%v/%v", coordinator, stopped, pausedDuring)
	}
	keeper.release()
	if fake.detaches != 0 {
		t.Fatal("a Manager-consumed lease must not be detached again")
	}
}

func TestCoordinatorRestartAdoptsNewLeaseAndResumes(t *testing.T) {
	next := testAttachment("44444444-4444-4444-8444-444444444444")
	next.Receipt.DaemonID = "daemon-2"
	next.Receipt.StartFingerprint = "fp-2"
	next.Lease.DaemonID = "daemon-2"
	fake := &fakeMaintenanceManager{start: testStart(), result: coremanager.MaintenanceResult{Operation: "restart", Stopped: true, RequestID: "33333333-3333-4333-8333-333333333333", Attachment: &next}}
	prompts := &fakePrompts{confirm: true}
	restarted := false
	coordinator, keeper := testCoordinator(fake, prompts, maintenanceHooks{OnRestarted: func(got coremanager.Attachment) { restarted = got.Lease.LeaseID == next.Lease.LeaseID }})
	revision := 7
	if !coordinator.Run(context.Background(), "restart", &revision) || !restarted {
		t.Fatal("restart did not adopt the replacement")
	}
	if keeper.current().Lease.LeaseID != next.Lease.LeaseID || fake.lastRevision == nil || *fake.lastRevision != 7 {
		t.Fatal("keeper/revision binding lost")
	}
	keeper.mu.Lock()
	paused := keeper.paused
	keeper.mu.Unlock()
	if paused {
		t.Fatal("successful restart must resume renewal")
	}
}

func TestCoordinatorExplicitRefusalResumesAndMayBeRetriedManually(t *testing.T) {
	fake := &fakeMaintenanceManager{start: testStart(), maintainErr: &coremanager.ManagerError{Code: "active_clients", Message: "active_clients"}}
	prompts := &fakePrompts{confirm: true}
	coordinator, keeper := testCoordinator(fake, prompts, maintenanceHooks{})
	if coordinator.Run(context.Background(), "stop", nil) {
		t.Fatal("refusal must not complete")
	}
	keeper.mu.Lock()
	paused := keeper.paused
	keeper.mu.Unlock()
	if paused || coordinator.unknownRequest() != "" {
		t.Fatal("explicit refusal must resume and stay non-sticky")
	}
	fake.maintainErr = nil
	fake.result = coremanager.MaintenanceResult{Operation: "stop", Stopped: true, RequestID: "33333333-3333-4333-8333-333333333333"}
	if !coordinator.Run(context.Background(), "stop", nil) || fake.maintainCalls != 2 {
		t.Fatal("a later manual attempt after refusal must be possible")
	}
}

func TestCoordinatorUnknownOutcomeIsStickyUntilInspection(t *testing.T) {
	fake := &fakeMaintenanceManager{start: testStart(), maintainErr: &coremanager.UnknownOutcome{Reason: "lost"}}
	prompts := &fakePrompts{confirm: true}
	released := false
	coordinator, keeper := testCoordinator(fake, prompts, maintenanceHooks{OnReleasedForRecovery: func() { released = true }})
	if coordinator.Run(context.Background(), "restart", nil) {
		t.Fatal("unknown outcome must not complete")
	}
	keeper.mu.Lock()
	paused := keeper.paused
	keeper.mu.Unlock()
	if !paused || coordinator.unknownRequest() == "" {
		t.Fatal("unknown outcome must pause renewal and stick")
	}
	if coordinator.Run(context.Background(), "restart", nil) || fake.maintainCalls != 1 {
		t.Fatal("sticky unknown outcome must block a second dispatch")
	}
	fake.records = []coremanager.MaintenanceRecord{{SchemaVersion: 1, RequestID: "33333333-3333-4333-8333-333333333333", Operation: "restart", State: "recovery_required", Target: coremanager.StartState{DataRootID: testDataRoot, DescriptorHash: testDescriptor, StartFingerprint: "fp-1"}}}
	fake.start = nil
	if !coordinator.RunInspect(context.Background()) || fake.reconcileCalls != 1 || !released {
		t.Fatalf("inspect/recovery failed: calls=%d released=%v", fake.reconcileCalls, released)
	}
	if coordinator.unknownRequest() != "" || fake.detaches != 1 {
		t.Fatalf("recovery must clear stickiness after own detach: detaches=%d", fake.detaches)
	}
}

func TestPeerReleaseStoreRequiresMatchingAck(t *testing.T) {
	dir := t.TempDir()
	store := peerReleaseStore{dir: dir}
	done := make(chan error, 1)
	go func() { done <- store.request(context.Background(), "fp-1", 2*time.Second) }()
	var req *leaseReleaseRequest
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
		req, _ = store.pending()
		if req != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if req == nil || req.Fingerprint != "fp-1" {
		t.Fatal("release request was not published")
	}
	bad := *req
	bad.Fingerprint = "other"
	if err := store.acknowledge(bad); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		t.Fatalf("mismatched ack accepted: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	if err := store.acknowledge(*req); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("matching ack was not observed")
	}
	if _, err := os.Stat(filepath.Join(dir, "lease-release-request.json")); !os.IsNotExist(err) {
		t.Fatal("completed request must be removed")
	}
}

func TestPeerReleaseStoreDropsStaleRequest(t *testing.T) {
	dir := t.TempDir()
	store := peerReleaseStore{dir: dir}
	stale := leaseReleaseRequest{Nonce: "n", Fingerprint: "fp", ExpiresAt: time.Now().Add(-time.Minute).Format(time.RFC3339Nano)}
	if err := writeJSONFile(store.requestPath(), stale); err != nil {
		t.Fatal(err)
	}
	if req, _ := store.pending(); req != nil {
		t.Fatal("stale request must be ignored")
	}
}

func TestLeaseKeeperPauseSkipsRenewal(t *testing.T) {
	fake := &fakeMaintenanceManager{}
	host := coremanager.Host{ClientID: "desktop:test", InstanceID: "11111111-1111-4111-8111-111111111111", Kind: "desktop", Version: "1.0.0"}
	keeper := newLeaseKeeper(fake, host, testAttachment("22222222-2222-4222-8222-222222222222"), 18306, nil)
	keeper.pause()
	if err := keeper.renewOnce(context.Background()); err != nil || fake.heartbeats != 0 {
		t.Fatal("paused keeper renewed")
	}
	keeper.resume()
	if err := keeper.renewOnce(context.Background()); err != nil || fake.heartbeats != 1 {
		t.Fatal("resumed keeper did not renew")
	}
	if err := keeper.adopt(testAttachment("44444444-4444-4444-8444-444444444444")); err != nil {
		t.Fatal(err)
	}
	other := testAttachment("55555555-5555-4555-8555-555555555555")
	other.Lease.InstanceID = "66666666-6666-4666-8666-666666666666"
	if err := keeper.adopt(other); err == nil {
		t.Fatal("adopt must reject another client's lease")
	}
}

func TestManagedTrayActionsDispatchAutostartAndTerminalQuit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	openCh, autoCh, quitCh := make(chan struct{}, 1), make(chan struct{}, 1), make(chan struct{}, 1)
	channels := trayActionChannels{open: openCh, auto: autoCh, quit: quitCh}
	var order []string
	openCh <- struct{}{}
	go watchManagedTrayActions(ctx, channels, trayActionHandlers{
		onOpen: func() { order = append(order, "open"); autoCh <- struct{}{} },
		onAuto: func() { order = append(order, "auto"); quitCh <- struct{}{} },
		onQuit: func() { order = append(order, "quit") },
	})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && strings.Join(order, ",") != "open,auto,quit" {
		time.Sleep(10 * time.Millisecond)
	}
	if got := strings.Join(order, ","); got != "open,auto,quit" {
		t.Fatal(got)
	}
}

func TestManagedTrayWiringUsesCoordinatorNotLegacyStop(t *testing.T) {
	body, err := os.ReadFile("managed.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	for _, want := range []string{"打开 BlackHole", "startBackgroundUpdateChecks", "watchManagedTrayActions"} {
		if !strings.Contains(source, want) {
			t.Fatalf("managed tray wiring missing %s", want)
		}
	}
	// Core maintenance lives in the settings page; the tray keeps daily
	// actions only. Keep the menu from regrowing maintenance entries.
	for _, removed := range []string{"重启共享 Core", "停止共享 Core", "检查/恢复维护事务", "检查更新…", "取消更新下载"} {
		if strings.Contains(source, removed) {
			t.Fatalf("managed tray regained the maintenance entry %s", removed)
		}
	}
	for _, forbidden := range []string{"/daemon/stop", "/daemon/restart", "bootstrap.Run(", "OthersActive("} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("managed tray regained legacy lifecycle authority: %s", forbidden)
		}
	}
}

func TestSharedTrayAndWindowSyncAttachmentAndStop(t *testing.T) {
	dir := t.TempDir()
	store := peerReleaseStore{dir: dir}
	trayID := "11111111-1111-4111-8111-111111111111"
	store.announcePresenceWithInstance("fp-1", trayID)
	fp, gotID, ok := store.presenceInstance()
	if !ok || fp != "fp-1" || gotID != trayID {
		t.Fatalf("presenceInstance = %q %q %v", fp, gotID, ok)
	}
	next := testAttachment("44444444-4444-4444-8444-444444444444")
	next.Receipt.StartFingerprint = "fp-2"
	store.publishAttachment(next)
	consumed, ok := store.consumeAttachment()
	if !ok || consumed.Lease.LeaseID != next.Lease.LeaseID || consumed.Receipt.StartFingerprint != "fp-2" {
		t.Fatalf("consumeAttachment = %+v %v", consumed, ok)
	}
	if _, ok := store.consumeAttachment(); ok {
		t.Fatal("attachment notice must be consumed once")
	}
	store.publishStop("fp-2")
	if store.consumeStop("fp-1") {
		t.Fatal("mismatched fingerprint must not consume stop")
	}
	if !store.consumeStop("fp-2") {
		t.Fatal("matching fingerprint must consume stop")
	}
	if store.consumeStop("fp-2") {
		t.Fatal("stop notice must be consumed once")
	}
}
