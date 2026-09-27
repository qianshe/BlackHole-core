package main

import (
	"bytes"
	"image/png"
	"path/filepath"
	"strings"
	"testing"
)

func TestAutostartContents(t *testing.T) {
	p := launchAgentPlist(`/Apps/Black & Hole.app/blackhole`)
	if !strings.Contains(p, "<string>/Apps/Black &amp; Hole.app/blackhole</string><string>--tray</string>") || !strings.Contains(p, "<key>RunAtLoad</key><true/>") {
		t.Fatal(p)
	}
	d := desktopEntry(`/opt/black hole/$x"`)
	if !strings.Contains(d, `Exec="/opt/black hole/\$x\"" --tray`) {
		t.Fatal(d)
	}
}

func TestFileAutostartRoundTrip(t *testing.T) {
	f := fileAutostart{filepath.Join(t.TempDir(), "a", "blackhole.desktop"), "x"}
	if f.enabled() {
		t.Fatal("enabled before set")
	}
	if err := f.set(true); err != nil || !f.enabled() {
		t.Fatal("set on", err)
	}
	if err := f.set(false); err != nil || f.enabled() {
		t.Fatal("set off", err)
	}
	if err := f.set(false); err != nil {
		t.Fatal("second off must be a no-op", err)
	}
}

func TestIcon(t *testing.T) {
	p := trayPNG(32)
	img, err := png.Decode(bytes.NewReader(p))
	if err != nil || img.Bounds().Dx() != 32 {
		t.Fatal(err)
	}
	ico := pngToICO(p, 32)
	if !bytes.Equal(ico[:6], []byte{0, 0, 1, 0, 1, 0}) || !bytes.Equal(ico[22:], p) {
		t.Fatal("bad ico header")
	}
}
