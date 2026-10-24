package coremanager

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"
)

// BundleStart is the same internal bootstrap contract used by VS Code. It
// returns a verified attachment, not merely a staged archive or selected path.
type BundleStart struct {
	State         string     `json:"state"`
	TargetVersion string     `json:"targetVersionName"`
	Attachment    Attachment `json:"attachment"`
	Reason        string     `json:"reason,omitempty"`
	Candidate     StagedCore `json:"-"` // locally validated immutable target for a busy-start continuation
}

func compareRuntimeVersion(a, b string) (int, error) {
	parse := func(v string) ([3]uint64, error) {
		var out [3]uint64
		parts := strings.Split(v, ".")
		if len(parts) != 3 {
			return out, errors.New("core_version_invalid")
		}
		for i, p := range parts {
			if p == "" || len(p) > 1 && p[0] == '0' {
				return out, errors.New("core_version_invalid")
			}
			for _, c := range p {
				if c < '0' || c > '9' {
					return out, errors.New("core_version_invalid")
				}
			}
			n, e := strconv.ParseUint(p, 10, 53)
			if e != nil {
				return out, e
			}
			out[i] = n
		}
		return out, nil
	}
	x, e := parse(a)
	if e != nil {
		return 0, e
	}
	y, e := parse(b)
	if e != nil {
		return 0, e
	}
	for i := range x {
		if x[i] > y[i] {
			return 1, nil
		}
		if x[i] < y[i] {
			return -1, nil
		}
	}
	return 0, nil
}

// StartBundled is called with the immutable distribution seed. Staging stays
// separate and harmless; only the common startup transaction may select/stop.
func (c Client) StartBundled(ctx context.Context, host Host, port int, seed, hash, requestID string) (BundleStart, error) {
	staged, err := c.StageBundledCore(ctx, seed, hash)
	if err != nil {
		return BundleStart{}, err
	}
	return c.StartStagedBundle(ctx, host, port, staged, requestID)
}
func (c Client) StartStagedBundle(ctx context.Context, host Host, port int, staged StagedCore, requestID string) (BundleStart, error) {
	var out BundleStart
	if !uuidPattern.MatchString(requestID) || !uuidPattern.MatchString(host.InstanceID) || host.ClientID == "" || port < 1 || port > 65535 || !hashPattern.MatchString(staged.DescriptorHash) || staged.VersionName == "" {
		return out, errors.New("manager_request_invalid")
	}
	request := map[string]any{"requestId": requestID, "client": host, "port": port, "versionName": staged.VersionName, "descriptorHash": staged.DescriptorHash, "reconnectAfterUpgrade": true}
	if err := c.invoke(ctx, map[string]any{"command": "start-bundled-core", "request": request}, &out); err != nil {
		return BundleStart{}, err
	}
	if out.TargetVersion != staged.VersionName {
		return BundleStart{}, &UnknownOutcome{Reason: "bundle target mismatch"}
	}
	if err := validateAttachment(out.Attachment, host, port); err != nil {
		return BundleStart{}, err
	}
	cmp, err := compareRuntimeVersion(out.Attachment.Receipt.RuntimeVersion, staged.RuntimeVersion)
	if err != nil {
		return BundleStart{}, &UnknownOutcome{Reason: "bundle version invalid"}
	}
	switch out.State {
	case "current", "updated":
		if cmp < 0 || cmp == 0 && out.Attachment.Receipt.DescriptorHash != staged.DescriptorHash || out.Reason != "" {
			return BundleStart{}, &UnknownOutcome{Reason: "bundle not applied"}
		}
	case "deferred":
		if cmp >= 0 || out.Reason == "" {
			return BundleStart{}, &UnknownOutcome{Reason: "invalid deferred bundle"}
		}
	case "rolled_back":
		if cmp >= 0 {
			return BundleStart{}, &UnknownOutcome{Reason: "invalid bundle rollback"}
		}
	default:
		return BundleStart{}, &UnknownOutcome{Reason: "unknown bundle state"}
	}
	out.Candidate = staged
	return out, nil
}

// RestoreAttachment cannot cold-start. Reconnect requires the exact old lease
// registration plus a completed signed transaction. An expired lease on the
// unchanged incarnation may instead use the fingerprint-pinned attach route.
func (c Client) RestoreAttachment(ctx context.Context, host Host, prior Attachment, port int) (Attachment, error) {
	var out Attachment
	err := c.invoke(ctx, map[string]any{"command": "reconnect-core", "request": map[string]any{"handle": prior.Lease.Handle(), "client": host, "port": port}}, &out)
	if err != nil {
		var refusal *ManagerError
		if !errors.As(err, &refusal) || refusal.Code != "core_reconnect_unproven" {
			return Attachment{}, err
		}
		request := map[string]any{"client": host, "port": port, "existingFingerprint": prior.Receipt.StartFingerprint, "reconnectAfterUpgrade": true}
		if err = c.invoke(ctx, map[string]any{"command": "attach-or-start", "request": request}, &out); err != nil {
			return Attachment{}, err
		}
		if out.Spawned || out.Receipt.DaemonID != prior.Receipt.DaemonID || out.Receipt.StartFingerprint != prior.Receipt.StartFingerprint || out.Receipt.DescriptorHash != prior.Receipt.DescriptorHash {
			return Attachment{}, &UnknownOutcome{Reason: "same-core reattachment mismatch"}
		}
	}
	if err = validateAttachment(out, host, port); err != nil {
		return Attachment{}, err
	}
	expires, e := time.Parse(time.RFC3339Nano, out.Lease.ExpiresAt)
	if e != nil || !expires.After(time.Now()) || out.Spawned || out.Receipt.DataRootID != prior.Receipt.DataRootID || out.Receipt.Environment != prior.Receipt.Environment || out.Receipt.CloudOrigin != prior.Receipt.CloudOrigin || out.Receipt.RuntimeID != prior.Receipt.RuntimeID {
		return Attachment{}, &UnknownOutcome{Reason: "reconnected Core mismatch"}
	}
	return out, nil
}
