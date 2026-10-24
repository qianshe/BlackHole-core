package main

import (
	"context"
	"errors"
	"sync"
	"time"

	"blackhole/desktop-launcher/internal/coremanager"
)

// leaseKeeperClient is the only Manager surface the keeper needs. Keeping it
// narrow lets the maintenance coordinator be tested without a Manager process.
type leaseKeeperClient interface {
	Heartbeat(ctx context.Context, handle coremanager.Handle, port int) (coremanager.Lease, error)
	Detach(ctx context.Context, handle coremanager.Handle) error
}

// leaseKeeper owns exactly one Manager lease for this native process. It
// renews on the Manager cadence, can be paused while its owner runs a bound
// maintenance transaction (so a heartbeat cannot queue behind the lifecycle
// lock or renew a lease the transaction is consuming), and detaches only its
// own lease on release. It never stops or restarts Core.
type bundleRuntimeClient interface {
	RestoreAttachment(context.Context, coremanager.Host, coremanager.Attachment, int) (coremanager.Attachment, error)
	StartStagedBundle(context.Context, coremanager.Host, int, coremanager.StagedCore, string) (coremanager.BundleStart, error)
}

type leaseKeeper struct {
	reconnect     bool
	pendingBundle *coremanager.StagedCore
	waitingSince  time.Time
	onReconnected func(coremanager.Attachment)
	client        leaseKeeperClient
	host          coremanager.Host
	port          int
	onLost        func()

	mu         sync.Mutex
	attachment coremanager.Attachment
	paused     bool
	renewing   bool
	renewDone  chan struct{}
	stopped    bool
	cancel     context.CancelFunc
	done       chan struct{}
}

func newLeaseKeeper(client leaseKeeperClient, host coremanager.Host, attachment coremanager.Attachment, port int, onLost func()) *leaseKeeper {
	return &leaseKeeper{client: client, host: host, attachment: attachment, port: port, onLost: onLost}
}

func (k *leaseKeeper) start() {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.cancel != nil || k.stopped {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	k.cancel = cancel
	k.done = make(chan struct{})
	go k.loop(ctx, k.done, 15*time.Second)
}

func (k *leaseKeeper) loop(ctx context.Context, done chan struct{}, interval time.Duration) {
	defer close(done)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if err := k.renewOnce(ctx); err != nil {
			k.mu.Lock()
			stopped := k.stopped
			attachment := k.attachment
			k.mu.Unlock()
			if stopped {
				return
			}
			// A transient failure — Manager lock contention, a slow daemon
			// probe, an uncertain outcome — does not end the claim while the
			// recorded lease is still valid; the next tick retries the same
			// handle and the Manager re-validates identity on every renewal.
			// Only a definitive refusal or a genuinely expired lease ends the
			// claim. This mirrors the tolerance the reconnect path already
			// applies and the VS Code host relies on for the same error codes.
			if leaseTransientFailure(err) && leaseStillValid(attachment, time.Now()) {
				desktopLog("lease renew deferred: " + err.Error())
				continue
			}
			desktopLog("lease lost: " + err.Error())
			// A failed renewal ends this client's claim: attempt to detach
			// only our own lease, then report the loss. Core is never stopped.
			detachCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = k.client.Detach(detachCtx, attachment.Lease.Handle())
			cancel()
			if ctx.Err() == nil && k.onLost != nil {
				k.onLost()
			}
			return
		}
	}
}

// leaseTransientFailure reports whether a failed renewal is worth retrying on
// a later tick. Refusals that name the lease or contradict its recorded
// identity are definitive; anything else (lock contention, daemon probe
// timeouts, spawn failures, uncertain outcomes) is treated as transient.
func leaseTransientFailure(err error) bool {
	var refusal *coremanager.ManagerError
	if errors.As(err, &refusal) {
		switch refusal.Code {
		case "lease_missing", "lease_expired", "core_identity_conflict",
			"environment_mismatch", "data_root_conflict", "foreign_listener":
			return false
		}
	}
	return true
}

func leaseStillValid(attachment coremanager.Attachment, now time.Time) bool {
	expires, err := time.Parse(time.RFC3339Nano, attachment.Lease.ExpiresAt)
	return err == nil && expires.After(now)
}

func (k *leaseKeeper) renewOnce(ctx context.Context) error {
	k.mu.Lock()
	if k.paused || k.stopped || k.renewing {
		k.mu.Unlock()
		return nil
	}
	k.renewing = true
	done := make(chan struct{})
	k.renewDone = done
	prior := k.attachment
	pending, reconnect, waiting := k.pendingBundle, k.reconnect, k.waitingSince
	k.mu.Unlock()
	next := prior
	bindingVerified := false
	runtime, canRestore := k.client.(bundleRuntimeClient)
	restoring := reconnect && canRestore && !waiting.IsZero()
	var err error
	if !restoring {
		var lease coremanager.Lease
		lease, err = k.client.Heartbeat(ctx, prior.Lease.Handle(), k.port)
		if err == nil {
			if lease.Handle() != prior.Lease.Handle() {
				err = errors.New("lease_target_mismatch")
			} else {
				next.Lease = lease
				bindingVerified = true
			}
		} else if reconnect && canRestore {
			var refusal *coremanager.ManagerError
			restoring = errors.As(err, &refusal) && (refusal.Code == "lease_missing" || refusal.Code == "lease_expired" || refusal.Code == "core_identity_conflict" || refusal.Code == "daemon_state_unknown")
			if !restoring {
				// Retry only the same still-valid handle for an uncertain heartbeat.
				expires, _ := time.Parse(time.RFC3339Nano, prior.Lease.ExpiresAt)
				var uncertain *coremanager.UnknownOutcome
				if expires.After(time.Now()) && (errors.As(err, &uncertain) || (refusal != nil && refusal.Code == "lock_busy")) {
					err = nil
				}
			}
		}
	}
	if restoring {
		next, err = runtime.RestoreAttachment(ctx, k.host, prior, k.port)
		var refusal *coremanager.ManagerError
		if err == nil {
			waiting = time.Time{}
			bindingVerified = true
		}
		if errors.As(err, &refusal) && refusal.Code == "upgrade_in_progress" {
			if waiting.IsZero() {
				waiting = time.Now()
			}
			if time.Since(waiting) < 120*time.Second {
				next = prior
				err = nil
			}
		}
	}
	if err == nil && bindingVerified && pending != nil && canRestore && waiting.IsZero() && ctx.Err() == nil {
		result, updateErr := runtime.StartStagedBundle(ctx, k.host, k.port, *pending, instanceID())
		if updateErr == nil {
			next = result.Attachment
			// A validated rollback keeps its restored attachment alive but never
			// schedules the failed candidate again in this host lifetime.
			if result.State != "deferred" {
				pending = nil
			}
		} else {
			err = updateErr
		}
	}
	if next.Lease.LeaseID != prior.Lease.LeaseID {
		waiting = time.Time{}
	}
	k.mu.Lock()
	late := k.stopped || k.attachment.Lease.LeaseID != prior.Lease.LeaseID
	if !late && err == nil {
		k.attachment = next
		k.pendingBundle = pending
		k.waitingSince = waiting
	}
	k.renewing = false
	close(done)
	callback := k.onReconnected
	k.mu.Unlock()
	if late && next.Lease.LeaseID != prior.Lease.LeaseID && next.Lease.InstanceID == k.host.InstanceID {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = k.client.Detach(cleanup, next.Lease.Handle())
		cancel()
	}
	if !late && err == nil && next.Receipt.DaemonID != prior.Receipt.DaemonID && callback != nil {
		callback(next)
	}
	return err
}

// Only the new bundle bootstrap registers transaction-based reconnection.
// Legacy/manual attachment paths retain their existing fail-closed behavior.
func (k *leaseKeeper) useBundle(start coremanager.BundleStart, callback func(coremanager.Attachment)) {
	k.reconnect = true
	k.onReconnected = callback
	if start.State == "deferred" {
		target := start.Candidate
		k.pendingBundle = &target
	}
}

// pause stops new renewals and waits for an in-flight renewal to finish. The
// caller owns the lease while paused; expiry remains the conservative
// fallback if the owner never resumes.
func (k *leaseKeeper) pause() {
	k.mu.Lock()
	k.paused = true
	for k.renewing {
		done := k.renewDone
		k.mu.Unlock()
		<-done
		k.mu.Lock()
	}
	k.mu.Unlock()
}

func (k *leaseKeeper) resume() {
	k.mu.Lock()
	k.paused = false
	k.mu.Unlock()
}

func (k *leaseKeeper) current() coremanager.Attachment {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.attachment
}

// adopt replaces the held lease after a Manager-validated restart. The new
// attachment must still belong to this host and port.
func (k *leaseKeeper) adopt(next coremanager.Attachment) error {
	if next.Lease.ClientID != k.host.ClientID || next.Lease.InstanceID != k.host.InstanceID || next.Lease.Kind != k.host.Kind {
		return errors.New("maintenance_target_changed")
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.stopped {
		return errors.New("managed_client_disposed")
	}
	k.attachment = next
	return nil
}

// markConsumed records that the Manager consumed the held lease (a completed
// Stop deletes it). Release afterwards must not detach a stale handle.
func (k *leaseKeeper) markConsumed() {
	k.mu.Lock()
	k.stopped = true
	k.mu.Unlock()
}

// release stops renewal and detaches the held lease with a fresh bounded
// context, mirroring KeepAlive's local-teardown semantics.
func (k *leaseKeeper) release() {
	k.mu.Lock()
	cancel, done, stopped := k.cancel, k.done, k.stopped
	attachment := k.attachment
	k.stopped = true
	k.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(12 * time.Second):
		}
	}
	if stopped {
		return
	}
	ctx, cancelDet := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelDet()
	_ = k.client.Detach(ctx, attachment.Lease.Handle())
}
