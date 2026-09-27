package main

import (
	"os"
	"path/filepath"
)

func autostartFile() fileAutostart {
	exe, _ := selfExe()
	home, _ := os.UserHomeDir()
	return fileAutostart{filepath.Join(home, "Library/LaunchAgents/ai.blackhole.launcher.plist"), launchAgentPlist(exe)}
}

func autostartEnabled() bool     { return autostartFile().enabled() }
func setAutostart(on bool) error { return autostartFile().set(on) }
