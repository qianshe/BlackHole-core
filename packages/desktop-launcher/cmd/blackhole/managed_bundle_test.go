package main

import (
	"blackhole/desktop-launcher/internal/coremanager"
	"context"
	"testing"
	"time"
)

type bundledKeeperFake struct {
	prior, next                       coremanager.Attachment
	heartbeatErr, restoreErr          error
	starts, restores, beats, detaches int
	resultState                       string
}

func (f *bundledKeeperFake) Heartbeat(context.Context, coremanager.Handle, int) (coremanager.Lease, error) {
	f.beats++
	return f.prior.Lease, f.heartbeatErr
}
func (f *bundledKeeperFake) Detach(context.Context, coremanager.Handle) error {
	f.detaches++
	return nil
}
func (f *bundledKeeperFake) RestoreAttachment(context.Context, coremanager.Host, coremanager.Attachment, int) (coremanager.Attachment, error) {
	f.restores++
	return f.next, f.restoreErr
}
func (f *bundledKeeperFake) StartStagedBundle(context.Context, coremanager.Host, int, coremanager.StagedCore, string) (coremanager.BundleStart, error) {
	f.starts++
	return coremanager.BundleStart{State: f.resultState, Attachment: f.next}, nil
}
func bundleKeeperFixture() (*leaseKeeper, *bundledKeeperFake) {
	prior := testAttachment("22222222-2222-4222-8222-222222222222")
	prior.Lease.ExpiresAt = time.Now().Add(45 * time.Second).Format(time.RFC3339Nano)
	next := prior
	next.Lease.LeaseID = "44444444-4444-4444-8444-444444444444"
	next.Lease.DaemonID = "new"
	next.Receipt.DaemonID = "new"
	next.Receipt.StartFingerprint = "new-fingerprint"
	fake := &bundledKeeperFake{prior: prior, next: next, resultState: "updated"}
	host := coremanager.Host{ClientID: prior.Lease.ClientID, InstanceID: prior.Lease.InstanceID, Kind: prior.Lease.Kind}
	return newLeaseKeeper(fake, host, prior, 18306, nil), fake
}
func TestDesktopPeerReconnectIsJournalBasedAndDoesNotStartAnotherCore(t *testing.T) {
	k, f := bundleKeeperFixture()
	rebound := 0
	k.useBundle(coremanager.BundleStart{State: "current"}, func(coremanager.Attachment) { rebound++ })
	f.heartbeatErr = &coremanager.ManagerError{Code: "lease_missing"}
	if err := k.renewOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.restores != 1 || f.starts != 0 || rebound != 1 || k.current().Receipt.DaemonID != "new" {
		t.Fatal(f, rebound, k.current())
	}
}
func TestDesktopWaitsForUpgradeWithoutResumingStaleHeartbeatOrStartingAgain(t *testing.T) {
	k, f := bundleKeeperFixture()
	k.useBundle(coremanager.BundleStart{State: "current"}, nil)
	f.heartbeatErr = &coremanager.ManagerError{Code: "lease_missing"}
	f.restoreErr = &coremanager.ManagerError{Code: "upgrade_in_progress"}
	if err := k.renewOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if k.waitingSince.IsZero() {
		t.Fatal("must retain bounded transaction wait")
	}
	f.restoreErr = nil
	f.next = f.prior
	if err := k.renewOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.beats != 1 || f.restores != 2 || !k.waitingSince.IsZero() {
		t.Fatal(f, k.waitingSince)
	}
}
func TestDesktopPendingUpdateRequiresConfirmedLeaseAndClearsAfterApplication(t *testing.T) {
	k, f := bundleKeeperFixture()
	target := coremanager.StagedCore{VersionName: "0.4.7-next", RuntimeVersion: "0.4.7"}
	k.useBundle(coremanager.BundleStart{State: "deferred", Candidate: target}, nil)
	f.heartbeatErr = &coremanager.UnknownOutcome{Reason: "heartbeat timeout"}
	if err := k.renewOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.starts != 0 {
		t.Fatal("an unconfirmed read cannot authorize an update")
	}
	f.heartbeatErr = nil
	if err := k.renewOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.starts != 1 || k.pendingBundle != nil || k.current().Receipt.DaemonID != "new" {
		t.Fatal(f, k.pendingBundle)
	}
}
func TestDesktopRollbackKeepsRestoredLeaseButDoesNotRetryBadCandidate(t *testing.T) {
	k, f := bundleKeeperFixture()
	f.resultState = "rolled_back"
	k.useBundle(coremanager.BundleStart{State: "deferred", Candidate: coremanager.StagedCore{VersionName: "bad"}}, nil)
	if err := k.renewOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if k.pendingBundle != nil || k.current().Lease.LeaseID != f.next.Lease.LeaseID {
		t.Fatal("must own restored lease without retry")
	}
}
