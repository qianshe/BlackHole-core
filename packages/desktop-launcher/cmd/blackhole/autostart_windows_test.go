package main

import "testing"

func TestRegistryAutostartRoundTrip(t *testing.T) {
	runValue = "BlackHoleTest-autostart" // never the real entry
	t.Cleanup(func() { _ = setAutostart(false); runValue = "BlackHole" })
	if autostartEnabled() {
		t.Fatal("enabled before set")
	}
	if err := setAutostart(true); err != nil || !autostartEnabled() {
		t.Fatal("on", err)
	}
	if err := setAutostart(false); err != nil || autostartEnabled() {
		t.Fatal("off", err)
	}
}
