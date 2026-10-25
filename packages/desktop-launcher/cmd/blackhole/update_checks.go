package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"blackhole/desktop-launcher/internal/distribution"
	"blackhole/desktop-launcher/internal/updatefeed"
)

var updateChecks struct {
	sync.Mutex
	key     string
	checker *updatefeed.Checker
}

func nativeChecker(bundle distribution.Bundle) (updatefeed.Feed, *updatefeed.Checker, string, error) {
	if runtime.GOOS != "windows" || runtime.GOARCH != "amd64" {
		return updatefeed.Feed{}, nil, "", errors.New("platform_updater_not_implemented")
	}
	f, err := updatefeed.FromBuild()
	if err != nil {
		return f, nil, "", err
	}
	if f.Config.Environment != bundle.Environment || f.Config.CurrentVersion != bundle.Version {
		return f, nil, "", errors.New("update_environment_mismatch")
	}
	root, err := updatefeed.DefaultStageRoot(f.Config.Environment)
	if err != nil {
		return f, nil, "", err
	}
	key := root + "\x00" + bundle.Version
	updateChecks.Lock()
	defer updateChecks.Unlock()
	if updateChecks.checker == nil || updateChecks.key != key {
		updateChecks.key = key
		updateChecks.checker = updatefeed.NewChecker(f, filepath.Join(root, "check-state.json"))
	}
	return f, updateChecks.checker, root, nil
}

// startBackgroundUpdateChecks runs the metadata-only daily check silently so
// the settings card can surface a new version without a manual click. It
// never downloads or installs; the preferences file can disable it.
func startBackgroundUpdateChecks(ctx context.Context, bundle distribution.Bundle) {
	_, checker, root, err := nativeChecker(bundle)
	if err != nil {
		return // No configured release source: never make a network request.
	}
	var p struct {
		Automatic bool `json:"automatic"`
	}
	p.Automatic = true
	if raw, e := os.ReadFile(filepath.Join(root, "preferences.json")); e == nil && len(raw) <= 1024 {
		_ = json.Unmarshal(raw, &p)
	}
	if !p.Automatic {
		return
	}
	// Opening Desktop is the moment update discovery matters most: check once
	// immediately (metadata only) instead of waiting out the daily cadence.
	// Desktop sessions also outlive release moments, so keep force-checking
	// the signed feed every 15 minutes while the app is open — the rail then
	// surfaces a version published mid-session without a manual refresh.
	go func() {
		checker.Check(ctx, true)
		ticker := time.NewTicker(15 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				checker.Check(ctx, true)
			}
		}
	}()
}

// Native bridge exposes status, an explicitly requested check, the
// page-authorized download-and-install flow and download cancellation.
// It never accepts URL/path/install arguments from a rendered page.
func desktopUpdateAction(action string) (string, error) {
	bundle, err := distribution.Locate()
	if err != nil {
		return "", err
	}
	_, checker, root, err := nativeChecker(bundle)
	if err != nil {
		code := "update_unavailable"
		if err.Error() == "update_feed_unconfigured" {
			code = "unconfigured"
		}
		if err.Error() == "platform_updater_not_implemented" {
			code = "unsupported"
		}
		raw, _ := json.Marshal(map[string]any{"state": code, "currentVersion": bundle.Version})
		return string(raw), nil
	}
	switch action {
	case "status":
	case "cancel-download":
		updatefeed.RequestDownloadCancel(root, bundle.Version)
	case "check":
		go checker.Check(context.Background(), true)
		raw, _ := json.Marshal(map[string]any{"state": "checking", "currentVersion": bundle.Version})
		return string(raw), nil
	case "download":
		// The window process owns a maintenance coordinator bound to the exact
		// Core incarnation; a click in the Desktop's own native-hosted UI is
		// the authorization the tray click used to provide. If the guarded
		// Manager stop is refused (live clients/work), the operator-authorized
		// fallback terminates exactly the recorded daemon so the update still
		// completes — updates never stall on Core state.
		stopForUpdate := func(ctx context.Context) bool {
			if windowCoordinator != nil && windowCoordinator.StopForUpdate(ctx) {
				return true
			}
			desktopLog("update stop refused by Manager; falling back to operator-authorized termination")
			fingerprint := ""
			if windowCoordinator != nil {
				fingerprint = windowCoordinator.keeper.current().Receipt.StartFingerprint
			}
			return forceStopCoreForUpdate(bundle, fingerprint)
		}
		finished := func() { closeManagedWindow() }
		go runDesktopUpdate(stopForUpdate, finished)
		raw, _ := json.Marshal(map[string]any{"state": "checking", "currentVersion": bundle.Version})
		return string(raw), nil
	default:
		return "", errors.New("update_action_invalid")
	}
	s := updatefeed.ReadCheckStatus(filepath.Join(root, "check-state.json"), bundle.Version)
	if local := checker.Status(); local.State == "checking" {
		s = local
	}
	raw, _ := json.Marshal(struct {
		updatefeed.CheckStatus
		Download updatefeed.DownloadStatus `json:"download"`
	}{s, updatefeed.ReadDownloadStatus(root, bundle.Version)})
	return string(raw), nil
}
