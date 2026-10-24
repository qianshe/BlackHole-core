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
	"fyne.io/systray"
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
	root, err := updatefeed.DefaultStageRoot(bundle.Environment)
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
func updateMenuTitle(s updatefeed.CheckStatus) string {
	switch s.State {
	case "available":
		return "有新版本 " + s.AvailableVersion + "…"
	case "checking":
		return "正在检查更新…"
	case "error":
		return "检查更新失败，点击重试…"
	default:
		return "检查更新…"
	}
}
func startAutomaticUpdateChecks(ctx context.Context, bundle distribution.Bundle, item *systray.MenuItem) {
	_, checker, root, err := nativeChecker(bundle)
	if err != nil {
		return
	} // No configured release source: never make a network request.
	watchUpdateTransfer(ctx, root, bundle.Version, checker, item)
	var p struct {
		Automatic bool `json:"automatic"`
	}
	preference := filepath.Join(root, "preferences.json")
	p.Automatic = true
	if raw, e := os.ReadFile(preference); e == nil && len(raw) <= 1024 {
		_ = json.Unmarshal(raw, &p)
	}
	automatic := systray.AddMenuItemCheckbox("自动检查更新", "只检查版本，不自动下载或重启", p.Automatic)
	var cancel context.CancelFunc
	run := func() {
		var sub context.Context
		sub, cancel = context.WithCancel(ctx)
		go checker.Run(sub, func(s updatefeed.CheckStatus) { item.SetTitle(updateMenuTitle(s)) })
	}
	item.SetTitle(updateMenuTitle(checker.Status()))
	if p.Automatic {
		run()
	}
	go func() {
		defer func() {
			if cancel != nil {
				cancel()
			}
		}()
		for {
			select {
			case <-ctx.Done():
				return
			case <-automatic.ClickedCh:
				next := !automatic.Checked()
				raw, _ := json.Marshal(struct {
					Automatic bool `json:"automatic"`
				}{next})
				if os.MkdirAll(root, 0700) != nil || os.WriteFile(preference, raw, 0600) != nil {
					showError("BlackHole", "无法保存自动更新检查设置。")
					continue
				}
				if cancel != nil {
					cancel()
					cancel = nil
				}
				if next {
					automatic.Check()
					run()
				} else {
					automatic.Uncheck()
				}
			}
		}
	}()
}

// Native bridge exposes status only and an explicitly requested check/offer.
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
