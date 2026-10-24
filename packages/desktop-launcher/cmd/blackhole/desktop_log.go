package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// The launcher previously kept no on-disk record of lease loss, deferred
// renewals or tray exits, so an automatic Desktop exit was undiagnosable in
// the field. desktopLog appends one timestamped line next to the daemon's own
// log. Write failures are silently ignored: logging must never influence the
// control flow it records. The directory resolves to the managed data root
// only after Locate(); before that (and in unit tests) calls are no-ops.
var desktopLogMu sync.Mutex

func desktopLog(message string) {
	desktopLogMu.Lock()
	defer desktopLogMu.Unlock()
	if managedUserDataDir == "" {
		return
	}
	dir := filepath.Join(managedUserDataDir, "logs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	path := filepath.Join(dir, "desktop.log")
	if info, err := os.Stat(path); err == nil && info.Size() > 1<<20 {
		_ = os.Rename(path, path+".old")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	fmt.Fprintf(file, "%s pid=%d %s\n", time.Now().Format("2006-01-02 15:04:05.000"), os.Getpid(), message)
}
