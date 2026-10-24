package coremanager

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// StagedCore is an immutable signed Core that Manager has verified and placed
// in its versioned store. Stage never selects/stops/starts a runtime.
type StagedCore struct {
	VersionName    string
	RuntimeVersion string
	DescriptorHash string
}

type ActiveCore struct {
	VersionName    string
	RuntimeVersion string
	DescriptorHash string
}

var coreSegmentPattern = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// StageBundledCore verifies the compiler-pinned archive hash before sending its
// absolute path to the signature-verifying Manager. No user-supplied path is used.
func (c Client) StageBundledCore(ctx context.Context, seed, expectedHash string) (StagedCore, error) {
	var result StagedCore
	if !filepath.IsAbs(seed) || !hashPattern.MatchString(expectedHash) {
		return result, errors.New("core_seed_invalid")
	}
	file, err := os.Open(seed)
	if err != nil {
		return result, err
	}
	hasher := sha256.New()
	_, copyErr := io.Copy(hasher, file)
	closeErr := file.Close()
	if copyErr != nil {
		return result, copyErr
	}
	if closeErr != nil {
		return result, closeErr
	}
	if hex.EncodeToString(hasher.Sum(nil)) != expectedHash {
		return result, errors.New("core_seed_hash_invalid")
	}
	var verified struct {
		Descriptor     json.RawMessage `json:"descriptor"`
		DescriptorHash string          `json:"descriptorHash"`
		ArchiveHash    string          `json:"archiveHash"`
		MemberCount    int             `json:"memberCount"`
	}
	if err := c.invoke(ctx, map[string]any{"command": "provision", "archive": seed, "source": "seed"}, &verified); err != nil {
		return result, err
	}
	var identity struct {
		RuntimeVersion string `json:"runtimeVersion"`
		BuildID        string `json:"buildId"`
	}
	if err := json.Unmarshal(verified.Descriptor, &identity); err != nil {
		return result, &UnknownOutcome{Reason: "invalid staged descriptor"}
	}
	if verified.ArchiveHash != expectedHash || verified.MemberCount <= 0 || !hashPattern.MatchString(verified.DescriptorHash) || identity.RuntimeVersion == "" || identity.BuildID == "" {
		return result, &UnknownOutcome{Reason: "invalid staged Core identity"}
	}
	runtime := strings.TrimSpace(coreSegmentPattern.ReplaceAllString(identity.RuntimeVersion, "_"))
	build := strings.TrimSpace(coreSegmentPattern.ReplaceAllString(identity.BuildID, "_"))
	if runtime == "" || build == "" || len(runtime) > 120 || len(build) > 120 {
		return result, &UnknownOutcome{Reason: "invalid staged version name"}
	}
	// Identical computation to the Manager's coreVersionName() (safeSegment).
	return StagedCore{
		VersionName:    runtime + "-" + build,
		RuntimeVersion: identity.RuntimeVersion,
		DescriptorHash: verified.DescriptorHash,
	}, nil
}

// SelectActive is read-only. The selected Core may differ from the running
// incarnation, which always takes priority when applying an update.
func (c Client) SelectActive(ctx context.Context) (*ActiveCore, error) {
	var raw json.RawMessage
	if err := c.invoke(ctx, map[string]any{"command": "select", "pointer": "active.json"}, &raw); err != nil {
		return nil, err
	}
	if string(raw) == "null" {
		return nil, nil
	}
	var selected struct {
		VersionName string `json:"versionName"`
		Identity    struct {
			RuntimeVersion string `json:"runtimeVersion"`
			DescriptorHash string `json:"descriptorHash"`
		} `json:"identity"`
	}
	if json.Unmarshal(raw, &selected) != nil || selected.VersionName == "" || selected.Identity.RuntimeVersion == "" || !hashPattern.MatchString(selected.Identity.DescriptorHash) {
		return nil, &UnknownOutcome{Reason: "invalid active Core selection"}
	}
	return &ActiveCore{VersionName: selected.VersionName, RuntimeVersion: selected.Identity.RuntimeVersion, DescriptorHash: selected.Identity.DescriptorHash}, nil
}

// ActivateCold replaces the selected pointer only through the Manager's guarded
// cold activation. Callers must first verify strictly newer runtime versions.
func (c Client) ActivateCold(ctx context.Context, versionName string, port int, expected *ActiveCore) error {
	if versionName == "" || len(versionName) > 250 || port < 1 || port > 65535 {
		return errors.New("core_activation_request_invalid")
	}
	request := map[string]any{"versionName": versionName, "port": port, "expectedVersionName": nil, "expectedDescriptorHash": nil}
	if expected != nil {
		request["expectedVersionName"] = expected.VersionName
		request["expectedDescriptorHash"] = expected.DescriptorHash
	}
	var out struct {
		VersionName string `json:"versionName"`
	}
	if err := c.invoke(ctx, map[string]any{"command": "activate-cold-core", "request": request}, &out); err != nil {
		return err
	}
	if out.VersionName != versionName {
		return &UnknownOutcome{Reason: "cold activation result mismatch"}
	}
	return nil
}

// CheckNoPendingChanges prevents a shell-only/same-Core install from claiming
// success while a previous Core upgrade or maintenance is unresolved. Mutating
// paths already gate on these journals inside the Manager locks.
func (c Client) CheckNoPendingChanges(ctx context.Context) error {
	var upgrades []json.RawMessage
	if err := c.invoke(ctx, map[string]any{"command": "inspect-upgrades"}, &upgrades); err != nil {
		return err
	}
	if upgrades == nil {
		return &UnknownOutcome{Reason: "upgrade_journal_invalid"}
	}
	if len(upgrades) != 0 {
		return errors.New("upgrade_recovery_required")
	}
	maintenance, err := c.InspectMaintenances(ctx)
	if err != nil {
		return err
	}
	if len(maintenance) != 0 {
		return errors.New("maintenance_recovery_required")
	}
	return nil
}
