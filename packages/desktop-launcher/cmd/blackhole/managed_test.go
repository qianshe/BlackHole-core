package main

import (
	"blackhole/desktop-launcher/internal/coremanager"
	"blackhole/desktop-launcher/internal/distribution"
	"path/filepath"
	"testing"
)

func TestManagedUIStateAndWindowFocusAreScoped(t *testing.T) {
	oldDir, oldTitle, oldData := managedStateDir, windowTitle, managedUserDataDir
	defer func() { managedStateDir = oldDir; windowTitle = oldTitle; managedUserDataDir = oldData }()
	root := filepath.Join(t.TempDir(), ".blackhole")
	configureManagedUI(distribution.Bundle{Client: coremanager.Client{Store: filepath.Join(root, "core")}}, 18342)
	// The window title intentionally carries no port; scoping is about the state dirs.
	if dataDir() != root || managedStateDir != filepath.Join(root, "runtime-state", "desktop", "18342") {
		t.Fatal("native cache and coordination escaped the sole user profile")
	}
}
func TestDesktopHostsHaveIndependentInstances(t *testing.T) {
	bundle := distribution.Bundle{Environment: "test", Version: "1.0.0"}
	first, second := desktopHost(bundle), desktopHost(bundle)
	if first.ClientID != "desktop:test" || first.InstanceID == second.InstanceID || len(first.InstanceID) != 36 {
		t.Fatal("window/tray instances not independent")
	}
}
