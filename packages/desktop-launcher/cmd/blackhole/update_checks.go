package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"

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
	go checker.Run(ctx, func(updatefeed.CheckStatus) {})
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
		// the authorization the tray click used to provide.
		stopForUpdate := func(context.Context) bool { return false }
		if windowCoordinator != nil {
			stopForUpdate = windowCoordinator.StopForUpdate
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
