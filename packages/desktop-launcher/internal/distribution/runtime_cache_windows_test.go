//go:build windows

package distribution

import (
	"errors"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestRuntimeVerificationWaitsForTransientWindowsDirectoryLock(t *testing.T) {
	root, store, h, l := runtimeFixture(t)
	exe, err := prepareRuntimeCache(root, store, h, l)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(exe)
	name, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ, 0, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	unlock := func() { once.Do(func() { syscall.CloseHandle(handle) }) }
	defer unlock()
	// Establish the actual filesystem failure before exercising bounded recovery.
	if err := verifyRuntimeCache(dir, h, l); !errors.Is(err, syscall.Errno(32)) {
		t.Fatalf("exclusive directory handle did not establish a sharing violation: %v", err)
	}
	released := make(chan struct{})
	go func() { time.Sleep(40 * time.Millisecond); unlock(); close(released) }()
	err = verifyRuntimeCache(dir, h, l)
	<-released
	if err != nil {
		t.Fatalf("valid pinned runtime rejected after transient lock: %v", err)
	}
}
