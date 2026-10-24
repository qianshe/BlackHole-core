package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"blackhole/desktop-launcher/internal/coremanager"
)

// fakeKeeperClient is a programmable leaseKeeperClient: the first errTimes
// Heartbeat calls fail with err, later calls renew the same lease identity
// with a fresh expiry. Detach calls are counted, never successful surprises.
type fakeKeeperClient struct {
	mu         sync.Mutex
	heartbeats int
	detaches   int
	err        error
	errTimes   int
}

func (f *fakeKeeperClient) Heartbeat(ctx context.Context, handle coremanager.Handle, port int) (coremanager.Lease, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.heartbeats++
	if f.err != nil && (f.errTimes == 0 || f.heartbeats <= f.errTimes) {
		return coremanager.Lease{}, f.err
	}
	return coremanager.Lease{
		SchemaVersion: 1, LeaseID: handle.LeaseID, ClientID: "desktop:test", InstanceID: handle.InstanceID,
		Kind: "desktop", RuntimeID: "node", BuildID: "build-1", DescriptorHash: handle.DescriptorHash,
		DataRootID: handle.DataRootID, DaemonID: handle.DaemonID,
		IssuedAt:  time.Now().Format(time.RFC3339Nano),
		ExpiresAt: time.Now().Add(45 * time.Second).Format(time.RFC3339Nano),
	}, nil
}

func (f *fakeKeeperClient) Detach(ctx context.Context, handle coremanager.Handle) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.detaches++
	return nil
}

func (f *fakeKeeperClient) counts() (heartbeats, detaches int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.heartbeats, f.detaches
}

func keeperTestAttachment(expiresIn time.Duration) coremanager.Attachment {
	attachment := testAttachment("22222222-2222-4222-8222-222222222222")
	if expiresIn > 0 {
		attachment.Lease.ExpiresAt = time.Now().Add(expiresIn).Format(time.RFC3339Nano)
	}
	return attachment
}

// runKeeper starts the renewal loop on a fast ticker and returns the lost
// channel (closed when onLost fires) plus a stop function.
func runKeeper(t *testing.T, client leaseKeeperClient, attachment coremanager.Attachment) (lost chan struct{}, stop func()) {
	t.Helper()
	host := coremanager.Host{ClientID: "desktop:test", InstanceID: "11111111-1111-4111-8111-111111111111", Kind: "desktop", Version: "1.0.0"}
	lost = make(chan struct{})
	keeper := newLeaseKeeper(client, host, attachment, 18306, func() { close(lost) })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go keeper.loop(ctx, done, 2*time.Millisecond)
	stop = func() {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Errorf("keeper loop did not stop")
		}
	}
	return lost, stop
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition not reached before timeout")
}

// A transient Manager lock refusal must not end the claim: the keeper stays
// alive, keeps its lease, and the next beat renews it. This is the scenario
// that used to quit the whole Desktop when another client held the store lock.
func TestKeeperToleratesTransientLockBusy(t *testing.T) {
	client := &fakeKeeperClient{err: &coremanager.ManagerError{Code: "lock_busy", Message: "held"}, errTimes: 3}
	lost, stop := runKeeper(t, client, keeperTestAttachment(45*time.Second))
	defer stop()
	waitFor(t, 2*time.Second, func() bool {
		heartbeats, detaches := client.counts()
		return heartbeats >= 5 && detaches == 0
	})
	select {
	case <-lost:
		t.Fatal("onLost fired for a transient lock_busy while the lease was valid")
	default:
	}
}

// A slow daemon probe (daemon_state_unknown) is not evidence that the core or
// the lease is gone; the keeper must ride it out the same way.
func TestKeeperToleratesTransientDaemonProbeFailure(t *testing.T) {
	client := &fakeKeeperClient{err: &coremanager.ManagerError{Code: "daemon_state_unknown", Message: "probe timeout"}, errTimes: 2}
	lost, stop := runKeeper(t, client, keeperTestAttachment(45*time.Second))
	defer stop()
	waitFor(t, 2*time.Second, func() bool {
		heartbeats, detaches := client.counts()
		return heartbeats >= 4 && detaches == 0
	})
	select {
	case <-lost:
		t.Fatal("onLost fired for a transient probe failure while the lease was valid")
	default:
	}
}

// An explicit expiry refusal ends the claim even while the local record still
// looks valid: the Manager is the authority on lease state.
func TestKeeperFailsClosedOnLeaseExpiredRefusal(t *testing.T) {
	client := &fakeKeeperClient{err: &coremanager.ManagerError{Code: "lease_expired", Message: "expired"}}
	lost, stop := runKeeper(t, client, keeperTestAttachment(45*time.Second))
	defer stop()
	waitFor(t, 2*time.Second, func() bool {
		_, detaches := client.counts()
		return detaches >= 1
	})
	select {
	case <-lost:
	default:
		t.Fatal("expected onLost after a definitive lease_expired refusal")
	}
}

// An identity conflict is definitive regardless of the locally recorded
// expiry: renewing across incarnations would be exactly the bug the lease
// binding exists to prevent.
func TestKeeperFailsClosedOnIdentityConflict(t *testing.T) {
	client := &fakeKeeperClient{err: &coremanager.ManagerError{Code: "core_identity_conflict", Message: "mismatch"}}
	lost, stop := runKeeper(t, client, keeperTestAttachment(45*time.Second))
	defer stop()
	waitFor(t, 2*time.Second, func() bool {
		_, detaches := client.counts()
		return detaches >= 1
	})
	select {
	case <-lost:
	default:
		t.Fatal("expected onLost after core_identity_conflict")
	}
}

// Once the recorded expiry has passed, even a transient-looking error must end
// the claim: tolerance never outlives the lease it is anchored to.
func TestKeeperFailsClosedAfterRecordedExpiry(t *testing.T) {
	client := &fakeKeeperClient{err: &coremanager.ManagerError{Code: "lock_busy", Message: "held"}}
	lost, stop := runKeeper(t, client, keeperTestAttachment(-1*time.Second))
	defer stop()
	waitFor(t, 2*time.Second, func() bool {
		_, detaches := client.counts()
		return detaches >= 1
	})
	select {
	case <-lost:
	default:
		t.Fatal("expected onLost after the recorded lease expiry passed")
	}
}

// Guard the classifier directly: generic and unknown-outcome errors stay
// transient, every lease-naming refusal stays definitive.
func TestLeaseTransientFailureClassification(t *testing.T) {
	transient := []error{
		&coremanager.ManagerError{Code: "lock_busy"},
		&coremanager.ManagerError{Code: "lock_state_unknown"},
		&coremanager.ManagerError{Code: "daemon_state_unknown"},
		&coremanager.ManagerError{Code: "daemon_probe_unknown"},
		&coremanager.UnknownOutcome{Reason: "manager exited"},
		errors.New("spawn failed"),
	}
	for _, err := range transient {
		if !leaseTransientFailure(err) {
			t.Fatalf("expected transient: %v", err)
		}
	}
	definitive := []error{
		&coremanager.ManagerError{Code: "lease_missing"},
		&coremanager.ManagerError{Code: "lease_expired"},
		&coremanager.ManagerError{Code: "core_identity_conflict"},
		&coremanager.ManagerError{Code: "environment_mismatch"},
		&coremanager.ManagerError{Code: "data_root_conflict"},
		&coremanager.ManagerError{Code: "foreign_listener"},
	}
	for _, err := range definitive {
		if leaseTransientFailure(err) {
			t.Fatalf("expected definitive: %v", err)
		}
	}
}
