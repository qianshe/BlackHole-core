package main

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"blackhole/desktop-launcher/internal/coremanager"
	"blackhole/desktop-launcher/internal/distribution"
)

// bundledCoreAPI is narrow so update preconditions can be tested without
// manipulating the operator's real Core store or starting a daemon.
type bundledCoreAPI interface {
	InspectStart(context.Context) (*coremanager.StartState, error)
	CheckNoPendingChanges(context.Context) error
	SelectActive(context.Context) (*coremanager.ActiveCore, error)
	StageBundledCore(context.Context, string, string) (coremanager.StagedCore, error)
	ActivateCold(context.Context, string, int, *coremanager.ActiveCore) error
	AttachExisting(context.Context, coremanager.Host, int, string) (coremanager.Attachment, error)
	Upgrade(context.Context, coremanager.Host, int, coremanager.Handle, string, string, string) (coremanager.UpgradeResult, error)
	Detach(context.Context, coremanager.Handle) error
}

type bundledCoreResult struct {
	State          string `json:"state"`
	VersionName    string `json:"versionName"`
	DescriptorHash string `json:"descriptorHash"`
}

var stableRuntimeVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

// A product update must increase the Core runtime version. Different Web
// buildIds at the same version are not automatically installed over one another
// (including in the cold path), so downgrade/replay is not possible.
func newerCoreVersion(target, current string) (bool, error) {
	if !stableRuntimeVersion.MatchString(target) || !stableRuntimeVersion.MatchString(current) {
		return false, errors.New("core_version_format_unsupported")
	}
	a, b := strings.Split(target, "."), strings.Split(current, ".")
	for i := 0; i < 3; i++ {
		l, le := strconv.ParseUint(a[i], 10, 32)
		r, re := strconv.ParseUint(b[i], 10, 32)
		if le != nil || re != nil {
			return false, errors.New("core_version_format_unsupported")
		}
		if l != r {
			return l > r, nil
		}
	}
	return false, nil
}

func applyBundledCore(ctx context.Context, api bundledCoreAPI, bundle distribution.Bundle, host coremanager.Host, port int) (bundledCoreResult, error) {
	var out bundledCoreResult
	// A stale or unknown start guard is never interpreted as a stopped Core.
	running, err := api.InspectStart(ctx)
	if err != nil {
		return out, err
	}
	if running != nil && (running.Status != "ready" || running.Receipt == nil || running.Port != port || running.StartFingerprint == "") {
		return out, errors.New("core_update_requires_resolved_start")
	}
	active, err := api.SelectActive(ctx)
	if err != nil {
		return out, err
	}

	// Signature and member verification happen inside the Manager's provision
	// transaction; the launcher also hashes against its immutable manifest.
	staged, err := api.StageBundledCore(ctx, bundle.Seed, bundle.SeedHash)
	if err != nil {
		return out, fmt.Errorf("bundled_core_stage_failed: %w", err)
	}
	if staged.VersionName == "" || staged.DescriptorHash == "" || staged.RuntimeVersion == "" {
		return out, errors.New("bundled_core_stage_invalid")
	}
	out.VersionName, out.DescriptorHash = staged.VersionName, staged.DescriptorHash

	if running == nil {
		if active != nil && active.VersionName == staged.VersionName && active.DescriptorHash == staged.DescriptorHash {
			if err := api.CheckNoPendingChanges(ctx); err != nil {
				return out, err
			}
			out.State = "unchanged"
			return out, nil
		}
		if active != nil {
			newer, err := newerCoreVersion(staged.RuntimeVersion, active.RuntimeVersion)
			if err != nil {
				return out, err
			}
			if !newer {
				// A shell packaged with older Core bytes must not downgrade a
				// newer shared Core installed by VS Code or another Desktop.
				if staged.RuntimeVersion == active.RuntimeVersion {
					return out, errors.New("core_identity_conflict")
				}
				if err := api.CheckNoPendingChanges(ctx); err != nil {
					return out, err
				}
				out.State = "reused_newer"
				return out, nil
			}
		}
		// Manager guards the exact active pointer (CAS), port closure, data
		// root, live leases and pending maintenance under install+lifecycle
		// locks. First install activates without starting Core.
		if err := api.ActivateCold(ctx, staged.VersionName, port, active); err != nil {
			return out, err
		}
		out.State = "activated"
		return out, nil
	}

	if running.VersionName == staged.VersionName && running.DescriptorHash == staged.DescriptorHash {
		if err := api.CheckNoPendingChanges(ctx); err != nil {
			return out, err
		}
		out.State = "unchanged"
		return out, nil
	}
	newer, err := newerCoreVersion(staged.RuntimeVersion, running.Receipt.RuntimeVersion)
	if err != nil {
		return out, err
	}
	if !newer {
		if staged.RuntimeVersion == running.Receipt.RuntimeVersion {
			return out, errors.New("core_identity_conflict")
		}
		// Only an exact, verified attachment can prove this older shell is
		// compatible with the newer Core. Never move the shared pointer back.
		attached, e := api.AttachExisting(ctx, host, port, running.StartFingerprint)
		if e != nil {
			return out, e
		}
		defer func() { _ = api.Detach(context.Background(), attached.Lease.Handle()) }()
		if attached.Receipt.DescriptorHash != running.DescriptorHash || attached.Receipt.DaemonID != running.Receipt.DaemonID || attached.Receipt.DataRootID != running.DataRootID {
			return out, errors.New("core_identity_conflict")
		}
		if e := api.CheckNoPendingChanges(ctx); e != nil {
			return out, e
		}
		out.State = "reused_newer"
		return out, nil
	}

	// One temporary, exact-incarnation native lease is required. The Manager
	// refuses active VS Code/other Desktop/browser leases and active Agent work;
	// its signed maintenance grant, journal and rollback decide all mutations.
	attached, err := api.AttachExisting(ctx, host, port, running.StartFingerprint)
	if err != nil {
		return out, err
	}
	defer func() {
		done, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = api.Detach(done, attached.Lease.Handle())
	}()
	if attached.Receipt.DescriptorHash != running.DescriptorHash || attached.Receipt.DaemonID != running.Receipt.DaemonID || attached.Receipt.DataRootID != running.DataRootID {
		return out, errors.New("core_update_target_changed")
	}

	id := instanceID()
	next, err := api.Upgrade(ctx, host, port, attached.Lease.Handle(), id, staged.VersionName, staged.DescriptorHash)
	if err != nil {
		var refusal *coremanager.ManagerError
		// A positive pre-stop refusal means other clients/Agent work won the
		// race. Desktop can finish installing its SHELL while the signed
		// candidate waits in the common Core store. Unknown outcomes must
		// still fail: never mistake an interrupted signed Stop for deferral.
		if errors.As(err, &refusal) && (refusal.Code == "active_clients" || refusal.Code == "active_work") {
			if checkErr := api.CheckNoPendingChanges(ctx); checkErr != nil {
				return out, fmt.Errorf("core_upgrade_refusal_requires_inspection: %w", checkErr)
			}
			after, checkErr := api.InspectStart(ctx)
			if checkErr == nil && after != nil && after.Status == "ready" && after.Receipt != nil &&
				after.Port == running.Port && after.DescriptorHash == running.DescriptorHash &&
				after.StartFingerprint == running.StartFingerprint && after.Receipt.DaemonID == running.Receipt.DaemonID {
				out.State = "deferred"
				return out, nil
			}
			return out, errors.New("core_upgrade_refusal_state_unknown")
		}
		return out, fmt.Errorf("core_upgrade_request_%s: %w", id, err)
	}
	done, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := api.Detach(done, next.Attachment.Lease.Handle()); err != nil {
		return out, fmt.Errorf("core_upgrade_detach_uncertain: %w", err)
	}
	if next.State != "committed" {
		return out, errors.New("core_upgrade_rolled_back")
	}
	after, err := api.InspectStart(ctx)
	if err != nil {
		return out, err
	}
	if after == nil || after.VersionName != staged.VersionName || after.DescriptorHash != staged.DescriptorHash || after.Receipt == nil || after.Receipt.DaemonID != next.Attachment.Receipt.DaemonID {
		return out, errors.New("core_upgrade_result_unconfirmed")
	}
	out.State = "upgraded"
	return out, nil
}
