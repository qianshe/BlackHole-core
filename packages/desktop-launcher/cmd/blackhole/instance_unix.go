//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

var trayLock *os.File // held for the life of the process

func acquireTray(port int) bool {
	dir := filepath.Join(dataDir(), "runtime-state")
	if os.MkdirAll(dir, 0o700) != nil {
		return true // no lock possible: prefer a tray over none
	}
	f, err := os.OpenFile(filepath.Join(dir, "tray-"+strconv.Itoa(port)+".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return true
	}
	if syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		f.Close()
		return false
	}
	trayLock = f
	return true
}
