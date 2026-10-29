//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"blackhole/desktop-launcher/internal/updatefeed"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func stageIsOwned(root, stage string) bool {
	if !filepath.IsAbs(root) || !filepath.IsAbs(stage) {
		return false
	}
	rel, err := filepath.Rel(root, stage)
	if err != nil || strings.ContainsAny(rel, "/\\") || !strings.HasPrefix(rel, "release-") || len(rel) <= len("release-") {
		return false
	}
	// Resolve junctions and reject a stage symlink/reparse point: a textual
	// path under LocalAppData is not proof it resides there physically.
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false
	}
	stageReal, err := filepath.EvalSymlinks(stage)
	if err != nil || !strings.EqualFold(filepath.Dir(stageReal), rootReal) {
		return false
	}
	info, err := os.Lstat(stage)
	return err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0
}
func installedShell(environment string) (string, error) {
	id := "StellarBridge.BlackHole.Desktop"
	if environment == "test" {
		id += ".Test"
	} else if environment != "production" {
		return "", errors.New("update_environment_invalid")
	}
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Uninstall\`+id+"_is1", registry.QUERY_VALUE)
	if err != nil {
		return "", err
	}
	defer key.Close()
	directory, _, err := key.GetStringValue("InstallLocation")
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(directory) {
		return "", errors.New("update_installed_location_invalid")
	}
	exe := filepath.Join(directory, "blackhole.exe")
	if _, err := os.Stat(exe); err != nil {
		return "", err
	}
	return exe, nil
}
func waitForOriginalExit(pid uint32) error {
	if pid == 0 {
		return errors.New("update_parent_pid_invalid")
	}
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if err != nil {
		// The parent may have closed before this detached helper opened it;
		// ERROR_INVALID_PARAMETER means the given PID no longer exists.
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return nil
		}
		return fmt.Errorf("update_parent_state_unknown: %w", err)
	}
	defer windows.CloseHandle(h)
	code, err := windows.WaitForSingleObject(h, 30*1000)
	if err != nil {
		return fmt.Errorf("update_parent_wait_failed: %w", err)
	}
	if code != windows.WAIT_OBJECT_0 {
		return errors.New("update_parent_still_running")
	}
	return nil
}

// Called only by a copied helper outside the installation. Nothing in this
// path invokes the bundled Core or holds the AppMutex.
func runUpdateHelper(args []string) int {
	if len(args) != 1 {
		showError("BlackHole", "update_helper_arguments_invalid")
		return 2
	}
	f, err := updatefeed.FromBuild()
	if err != nil {
		showError("BlackHole", err.Error())
		return 1
	}
	root, err := updatefeed.DefaultStageRoot(f.Config.Environment)
	if err != nil || !stageIsOwned(root, args[0]) {
		showError("BlackHole", "update_stage_location_invalid")
		return 1
	}
	manifest, setup, err := f.VerifyStage(args[0])
	if err != nil {
		showError("BlackHole", "更新文件验证失败："+err.Error())
		return 1
	}
	exe, err := installedShell(f.Config.Environment)
	if err != nil {
		showError("BlackHole", "无法确认安装路径："+err.Error())
		return 1
	}
	if err = waitForOriginalExit(uint32(os.Getppid())); err != nil {
		showError("BlackHole", "旧版 Desktop 尚未正常退出，未运行安装器："+err.Error())
		return 1
	}
	// The parent exiting does not clear every AppMutex: the tray is a separate
	// process and quits asynchronously after the published stop. Inno checks
	// these mutexes and, with message boxes suppressed, aborts on any hold.
	// Wait bounded so an ordinary exit race cannot fail the whole update.
	if err = waitForAppMutexRelease(f.Config.Environment, 60*time.Second); err != nil {
		showError("BlackHole", "仍有 BlackHole 实例在运行（请检查托盘），未运行安装器："+err.Error())
		return 1
	}
	// A second integrity read after parent exit prevents a stage file from
	// being swapped between the in-app check and this process handoff.
	if _, _, err = f.VerifyStage(args[0]); err != nil {
		showError("BlackHole", "更新文件验证失败："+err.Error())
		return 1
	}
	logFile := filepath.Join(args[0], "installer.log")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, setup,
		"/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER",
		"/NOCLOSEAPPLICATIONS", "/NORESTARTAPPLICATIONS", "/LOG="+logFile)
	command.Dir = args[0]
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err = command.Run(); err != nil {
		showError("BlackHole", fmt.Sprintf("更新 %s 未完成。可能仍有窗口或 Core 客户端正在运行。已保留安装日志与数据：%s\n%v", manifest.Label(), logFile, err))
		return 1
	}
	// The Inno postinstall --apply-bundled-core reports failure nonzero. Only
	// a successful installer exit permits relaunch.
	restarted, err := installedShell(f.Config.Environment)
	if err != nil || !strings.EqualFold(restarted, exe) {
		showError("BlackHole", "安装完成，但安装目录状态变化。请从开始菜单手动打开并检查版本。")
		return 1
	}
	start := exec.Command(restarted)
	start.Dir = filepath.Dir(restarted)
	if err = start.Start(); err != nil {
		showError("BlackHole", "更新安装完成，但无法自动重新打开："+err.Error())
		return 1
	}
	_ = start.Process.Release()
	return 0
}

// Spawn a trusted copy of the *running* launcher in the independent update
// directory. It waits for the owning Desktop process to exit before executing
// the verified Inno installer. No shell commands, forced termination or Core
// mutations run in the still-live Desktop UI process.
func handoffUpdate(stage string) error {
	current, err := selfExe()
	if err != nil {
		return err
	}
	f, err := updatefeed.FromBuild()
	if err != nil {
		return err
	}
	root, err := updatefeed.DefaultStageRoot(f.Config.Environment)
	if err != nil || !stageIsOwned(root, stage) {
		return errors.New("update_stage_location_invalid")
	}
	if _, _, err = f.VerifyStage(stage); err != nil {
		return err
	}
	source, err := os.Open(current)
	if err != nil {
		return err
	}
	defer source.Close()
	temp := filepath.Join(stage, "helper.partial")
	target := filepath.Join(stage, "update-helper.exe")
	out, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, source)
	syncErr := out.Sync()
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil {
		return syncErr
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(temp, target); err != nil {
		return err
	}
	cmd := exec.Command(target, "--update-helper", stage)
	cmd.Dir = stage
	if err = cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// waitForAppMutexRelease polls the Inno AppMutex set for this environment
// until every mutex is free or the timeout elapses. The updater already
// stopped the Core and closed its own window; a lingering tray process exits
// asynchronously after the published stop, so an ordinary exit race must not
// fail the whole update. A mutex still held after the timeout means a real
// instance is alive and the caller reports it instead of racing the installer.
func waitForAppMutexRelease(environment string, timeout time.Duration) error {
	names := []string{"Local\\BlackHoleDesktopInstall", "Local\\BlackHoleTray-7306", "Local\\BlackHoleTray-17306"}
	if environment == "test" {
		names = []string{"Local\\BlackHoleDesktopTestInstall", "Local\\BlackHoleTray-7306", "Local\\BlackHoleTray-17306"}
	}
	deadline := time.Now().Add(timeout)
	for {
		held := ""
		for _, name := range names {
			ptr, err := windows.UTF16PtrFromString(name)
			if err != nil {
				continue
			}
			h, err := windows.OpenMutex(windows.SYNCHRONIZE, false, ptr)
			if err == nil {
				windows.CloseHandle(h)
				held = name
				break
			}
		}
		if held == "" {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("update_mutex_still_held: %s", held)
		}
		time.Sleep(500 * time.Millisecond)
	}
}
