//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"blackhole/desktop-launcher/internal/distribution"
	"golang.org/x/sys/windows"
)

// Operator-authorized update termination. The settings-card click IS the
// authorization to replace this machine's Core, so when the guarded Manager
// stop is refused (a live client lease, active work) the update must still
// proceed: terminate exactly the daemon process named by the Manager's own
// run record — never by port heuristics or a recycled PID — after confirming
// the start fingerprint still matches what this window attached to. The
// installer replaces program files only; user data lives outside the install
// and SQLite recovers its WAL on the next start. The tray is asked to exit
// through the peer store so the install mutexes release quickly.
func forceStopCoreForUpdate(bundle distribution.Bundle, expectedFingerprint string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	state, err := bundle.Client.InspectStart(ctx)
	if err != nil || state == nil || state.Status != "ready" || state.PID <= 0 {
		desktopLog(fmt.Sprintf("update force-stop skipped: no ready run record (err=%v)", err))
		return false
	}
	if expectedFingerprint != "" && state.StartFingerprint != expectedFingerprint {
		desktopLog("update force-stop refused: run record names a different Core incarnation")
		return false
	}
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(state.PID))
	if err != nil {
		// Already gone: nothing to terminate, the update can proceed.
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			desktopLog("update force-stop: daemon already exited")
			return true
		}
		desktopLog("update force-stop failed to open pid: " + err.Error())
		return false
	}
	defer windows.CloseHandle(handle)
	var exitCode uint32
	if err := windows.GetExitCodeProcess(handle, &exitCode); err == nil && exitCode != 259 { // STILL_ACTIVE
		desktopLog("update force-stop: daemon already exiting")
		return true
	}
	if err := windows.TerminateProcess(handle, 1); err != nil {
		desktopLog("update force-stop terminate failed: " + err.Error())
		return false
	}
	// Wait until the process is actually gone so the port frees before the
	// helper hands off to the installer; an already-dying process settles fast.
	deadline := time.Now().Add(10 * time.Second)
	for {
		code, err := waitTerminated(handle, 1000)
		if err == nil && code != 259 {
			break
		}
		if time.Now().After(deadline) {
			desktopLog("update force-stop: daemon pid did not confirm exit within 10s; continuing")
			break
		}
	}
	desktopLog(fmt.Sprintf("update force-stop: terminated daemon pid=%d fingerprint=%s (operator-authorized update)", state.PID, state.StartFingerprint))
	// Ask the tray to exit now instead of waiting out its daemon-watch beats.
	(peerReleaseStore{dir: managedStateDir}).publishStop(state.StartFingerprint)
	return true
}

func waitTerminated(handle windows.Handle, timeoutMs uint32) (uint32, error) {
	_, err := windows.WaitForSingleObject(handle, timeoutMs)
	if err != nil {
		return 259, err
	}
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return 259, err
	}
	return code, nil
}
