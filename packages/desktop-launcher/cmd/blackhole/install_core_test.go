package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"blackhole/desktop-launcher/internal/coremanager"
	"blackhole/desktop-launcher/internal/distribution"
)

const (
	fakeOldHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	fakeNewHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	fakeRoot    = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
)

type fakeBundledAPI struct {
	running *coremanager.StartState
	active  *coremanager.ActiveCore
	staged  coremanager.StagedCore
	errorAt string
	calls   []string
	commit  bool
	upgradeErrorCode string
}

func (f *fakeBundledAPI) step(action string) error {
	f.calls = append(f.calls, action)
	if f.errorAt == action {
		return &coremanager.ManagerError{Code: "active_clients", Message: "fixture refusal"}
	}
	return nil
}
func (f *fakeBundledAPI) InspectStart(context.Context) (*coremanager.StartState, error) {
	if err := f.step("inspect"); err != nil {
		return nil, err
	}
	return f.running, nil
}
func (f *fakeBundledAPI) CheckNoPendingChanges(context.Context) error { return f.step("pending") }
func (f *fakeBundledAPI) SelectActive(context.Context) (*coremanager.ActiveCore, error) {
	if err := f.step("select"); err != nil {
		return nil, err
	}
	return f.active, nil
}
func (f *fakeBundledAPI) StageBundledCore(context.Context, string, string) (coremanager.StagedCore, error) {
	if err := f.step("stage"); err != nil {
		return coremanager.StagedCore{}, err
	}
	return f.staged, nil
}
func (f *fakeBundledAPI) ActivateCold(ctx context.Context, version string, port int, expected *coremanager.ActiveCore) error {
	if err := f.step("cold"); err != nil {
		return err
	}
	if version != f.staged.VersionName || port != 17306 || expected != f.active {
		return errors.New("bad_cold_target")
	}
	f.active = &coremanager.ActiveCore{VersionName: version, DescriptorHash: f.staged.DescriptorHash, RuntimeVersion: f.staged.RuntimeVersion}
	return nil
}
func oldLease() coremanager.Lease {
	return coremanager.Lease{LeaseID: "00000000-0000-4000-8000-000000000001", InstanceID: "00000000-0000-4000-8000-000000000002", DaemonID: "old", DataRootID: fakeRoot, DescriptorHash: fakeOldHash}
}
func newLease() coremanager.Lease {
	return coremanager.Lease{LeaseID: "00000000-0000-4000-8000-000000000003", InstanceID: "00000000-0000-4000-8000-000000000002", DaemonID: "new", DataRootID: fakeRoot, DescriptorHash: fakeNewHash}
}
func (f *fakeBundledAPI) AttachExisting(ctx context.Context, host coremanager.Host, port int, fingerprint string) (coremanager.Attachment, error) {
	if err := f.step("attach"); err != nil {
		return coremanager.Attachment{}, err
	}
	if f.running == nil || port != 17306 || fingerprint != f.running.StartFingerprint {
		return coremanager.Attachment{}, errors.New("bad_attach")
	}
	return coremanager.Attachment{Receipt: *f.running.Receipt, Lease: oldLease()}, nil
}
func (f *fakeBundledAPI) Upgrade(ctx context.Context, host coremanager.Host, port int, handle coremanager.Handle, id, target, hash string) (coremanager.UpgradeResult, error) {
	if err := f.step("upgrade"); err != nil {
		return coremanager.UpgradeResult{}, err
	}
	if f.upgradeErrorCode != "" {
		return coremanager.UpgradeResult{}, &coremanager.ManagerError{Code: f.upgradeErrorCode, Message: "fixture"}
	}
	if f.running == nil || handle.DaemonID != "old" || target != f.staged.VersionName || hash != fakeNewHash {
		return coremanager.UpgradeResult{}, errors.New("bad_upgrade")
	}
	if !f.commit {
		return coremanager.UpgradeResult{State: "rolled_back", Attachment: coremanager.Attachment{Lease: oldLease()}}, nil
	}
	f.running = &coremanager.StartState{VersionName: target, DescriptorHash: hash, DataRootID: fakeRoot, Port: 17306, Status: "ready", StartFingerprint: "newfp", Receipt: &coremanager.Receipt{DaemonID: "new", DescriptorHash: hash, RuntimeVersion: "0.3.202"}}
	return coremanager.UpgradeResult{State: "committed", Attachment: coremanager.Attachment{Receipt: *f.running.Receipt, Lease: newLease()}}, nil
}
func (f *fakeBundledAPI) Detach(ctx context.Context, handle coremanager.Handle) error {
	return f.step("detach")
}
func oldRunning() *coremanager.StartState {
	return &coremanager.StartState{
		SchemaVersion: 1, Status: "ready", VersionName: "0.3.201-old", DescriptorHash: fakeOldHash, DataRootID: fakeRoot,
		Port: 17306, StartFingerprint: "oldfp", Receipt: &coremanager.Receipt{DaemonID: "old", RuntimeVersion: "0.3.201", DescriptorHash: fakeOldHash, DataRootID: fakeRoot},
	}
}
func newStage() coremanager.StagedCore {
	return coremanager.StagedCore{VersionName: "0.3.202-new", RuntimeVersion: "0.3.202", DescriptorHash: fakeNewHash}
}
func oldStage() coremanager.StagedCore {
	return coremanager.StagedCore{VersionName: "0.3.201-old", RuntimeVersion: "0.3.201", DescriptorHash: fakeOldHash}
}
func runBundledFake(f *fakeBundledAPI) (bundledCoreResult, error) {
	b := distribution.Bundle{Seed: "fixture-only", SeedHash: fakeNewHash, Environment: "test", Version: "0.3.202"}
	return applyBundledCore(context.Background(), f, b, desktopHost(b), 17306)
}
func TestBundledCoreColdFirstInstall(t *testing.T) {
	f := &fakeBundledAPI{staged: newStage()}
	result, err := runBundledFake(f)
	if err != nil || result.State != "activated" || strings.Join(f.calls, ",") != "inspect,select,stage,cold" {
		t.Fatalf("%+v %v %v", result, err, f.calls)
	}
}
func TestBundledCoreSameRunningCoreIsNoop(t *testing.T) {
	f := &fakeBundledAPI{running: oldRunning(), staged: oldStage()}
	result, err := runBundledFake(f)
	if err != nil || result.State != "unchanged" || strings.Join(f.calls, ",") != "inspect,select,stage,pending" {
		t.Fatalf("%+v %v %v", result, err, f.calls)
	}
}
func TestBundledCoreNoopRefusesUnresolvedJournals(t *testing.T) {
	for _, cold := range []bool{false, true} {
		f := &fakeBundledAPI{running: oldRunning(), staged: oldStage(), errorAt: "pending"}
		if cold {
			f.running = nil
			f.active = &coremanager.ActiveCore{VersionName: oldStage().VersionName, DescriptorHash: fakeOldHash, RuntimeVersion: oldStage().RuntimeVersion}
		}
		_, err := runBundledFake(f)
		if err == nil || !strings.Contains(err.Error(), "active_clients") || !strings.Contains(strings.Join(f.calls, ","), "pending") {
			t.Fatal(cold, err, f.calls)
		}
	}
}
func TestBundledCoreUsesManagerUpgradeAndVerifiesNewIdentity(t *testing.T) {
	f := &fakeBundledAPI{running: oldRunning(), staged: newStage(), commit: true}
	result, err := runBundledFake(f)
	if err != nil || result.State != "upgraded" || strings.Join(f.calls, ",") != "inspect,select,stage,attach,upgrade,detach,inspect,detach" {
		t.Fatalf("%+v %v %v", result, err, f.calls)
	}
}
func TestBundledCoreNeverDowngrades(t *testing.T) {
	f := &fakeBundledAPI{running: oldRunning(), staged: coremanager.StagedCore{VersionName: "0.3.200-earlier", RuntimeVersion: "0.3.200", DescriptorHash: fakeNewHash}}
	result, err := runBundledFake(f)
	if err != nil || result.State != "reused_newer" || f.running.Receipt.DaemonID != "old" {
		t.Fatal(result, err, f.calls)
	}
	if strings.Contains(strings.Join(f.calls, ","), "upgrade") {
		t.Fatal(f.calls)
	}
}
func TestBundledCoreRefusesUnresolvedStartBeforeStaging(t *testing.T) {
	f := &fakeBundledAPI{running: oldRunning(), staged: newStage()}
	f.running.Status = "starting"
	_, err := runBundledFake(f)
	if err == nil || !strings.Contains(err.Error(), "core_update_requires_resolved_start") || strings.Join(f.calls, ",") != "inspect" {
		t.Fatal(err, f.calls)
	}
}
func TestBundledCoreDefersWithoutStoppingOtherClients(t *testing.T) {
	for _, refusal := range []string{"active_clients", "active_work"} {
		f := &fakeBundledAPI{running: oldRunning(), staged: newStage(), upgradeErrorCode: refusal}
		result, err := runBundledFake(f)
		if err != nil || result.State != "deferred" || f.running.Receipt.DaemonID != "old" {
			t.Fatal(refusal, result, err, f.calls)
		}
		if strings.Join(f.calls, ",") != "inspect,select,stage,attach,upgrade,pending,inspect,detach" {
			t.Fatal(refusal, f.calls)
		}
	}
}
func TestOlderDesktopCannotDowngradeNewerStoppedCore(t *testing.T) {
	f := &fakeBundledAPI{
		active: &coremanager.ActiveCore{VersionName: newStage().VersionName, RuntimeVersion: newStage().RuntimeVersion, DescriptorHash: fakeNewHash},
		staged: oldStage(),
	}
	result, err := runBundledFake(f)
	if err != nil || result.State != "reused_newer" || strings.Join(f.calls, ",") != "inspect,select,stage,pending" {
		t.Fatal(result, err, f.calls)
	}
}
func TestOlderDesktopCannotDowngradeNewerRunningCore(t *testing.T) {
	f := &fakeBundledAPI{
		running: oldRunning(),
		staged: coremanager.StagedCore{VersionName: "0.3.200-old", RuntimeVersion: "0.3.200", DescriptorHash: fakeNewHash},
	}
	result, err := runBundledFake(f)
	if err != nil || result.State != "reused_newer" || strings.Join(f.calls, ",") != "inspect,select,stage,attach,pending,detach" {
		t.Fatal(result, err, f.calls)
	}
}
func TestSameCoreVersionWithDifferentSignatureIsNotAccepted(t *testing.T) {
	f := &fakeBundledAPI{
		running: oldRunning(),
		staged: coremanager.StagedCore{VersionName: "0.3.201-other", RuntimeVersion: "0.3.201", DescriptorHash: fakeNewHash},
	}
	_, err := runBundledFake(f)
	if err == nil || !strings.Contains(err.Error(), "core_identity_conflict") {
		t.Fatal(err, f.calls)
	}
}
func TestBundledCoreUpgradeUnknownIsNotDeferred(t *testing.T) {
	f := &fakeBundledAPI{running: oldRunning(), staged: newStage(), upgradeErrorCode: "maintenance_outcome_requires_inspection"}
	_, err := runBundledFake(f)
	if err == nil || !strings.Contains(err.Error(), "maintenance_outcome_requires_inspection") {
		t.Fatal(err, f.calls)
	}
	if strings.Contains(strings.Join(f.calls, ","), "pending") {
		t.Fatal("unknown result must not be treated as harmless deferral", f.calls)
	}
}
func TestBundledCoreDoesNotConcealRollback(t *testing.T) {
	f := &fakeBundledAPI{running: oldRunning(), staged: newStage(), commit: false}
	_, err := runBundledFake(f)
	if err == nil || !strings.Contains(err.Error(), "rolled_back") {
		t.Fatal(err, f.calls)
	}
}
func TestBundledCoreColdCASRefusal(t *testing.T) {
	f := &fakeBundledAPI{active: &coremanager.ActiveCore{VersionName: "0.3.201-old", DescriptorHash: fakeOldHash, RuntimeVersion: "0.3.201"}, staged: newStage(), errorAt: "cold"}
	_, err := runBundledFake(f)
	if err == nil || f.active.VersionName != "0.3.201-old" {
		t.Fatal(err)
	}
}
func TestBundledCoreVersionParsingFailClosed(t *testing.T) {
	for _, pair := range [][2]string{{"0.3.202", "0.3.201"}, {"1.0.0", "0.999.999"}, {"0.3.201", "0.3.201"}, {"bad", "0.3.201"}, {"0.3.202-rc1", "0.3.201"}} {
		newer, err := newerCoreVersion(pair[0], pair[1])
		switch pair[0] {
		case "0.3.202", "1.0.0":
			if err != nil || !newer {
				t.Fatal(pair, err)
			}
		case "0.3.201":
			if err != nil || newer {
				t.Fatal(pair, err)
			}
		default:
			if err == nil {
				t.Fatal(pair)
			}
		}
	}
}
