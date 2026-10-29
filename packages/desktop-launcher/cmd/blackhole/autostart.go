package main

import (
	"os"
	"path/filepath"
	"strings"
)

// Autostart launches `<exe> --tray`: the daemon and tray start, no browser.
const autostartFlag = "--tray"

// WebView/cache remains under the same ~/.blackhole profile as the daemon.
// Per-port maintenance coordination lives separately in runtime-state/desktop.
func dataDir() string {
	if managedUserDataDir != "" {
		return managedUserDataDir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".blackhole")
}

func selfExe() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return exe, nil
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

func launchAgentPlist(exe string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ai.blackhole.launcher</string>
<key>ProgramArguments</key><array><string>` + xmlEscape(exe) + `</string><string>` + autostartFlag + `</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`
}

func desktopEntry(exe string) string {
	q := `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "`", "\\`", "$", `\$`).Replace(exe) + `"`
	return "[Desktop Entry]\nType=Application\nName=BlackHole\nExec=" + q + " " + autostartFlag + "\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n"
}

// fileAutostart is the macOS/Linux implementation: one file whose content names this exe.
type fileAutostart struct{ path, content string }

func (f fileAutostart) enabled() bool {
	b, err := os.ReadFile(f.path)
	return err == nil && string(b) == f.content
}

func (f fileAutostart) set(on bool) error {
	if !on {
		if err := os.Remove(f.path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(f.path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(f.path, []byte(f.content), 0o644)
}
