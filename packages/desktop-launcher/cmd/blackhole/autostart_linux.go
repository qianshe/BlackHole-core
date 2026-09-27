package main

import (
	"os"
	"path/filepath"
)

func autostartFile() fileAutostart {
	exe, _ := selfExe()
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return fileAutostart{filepath.Join(dir, "autostart/blackhole.desktop"), desktopEntry(exe)}
}

func autostartEnabled() bool     { return autostartFile().enabled() }
func setAutostart(on bool) error { return autostartFile().set(on) }
