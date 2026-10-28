package distribution

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMacBundleResourcesRetainPayloadPins(t *testing.T) {
	source, manifest := fixture(t)
	app := filepath.Join(t.TempDir(), "BlackHole.app")
	payload := filepath.Join(app, "Contents", "Resources", "BlackHole")
	if err := os.MkdirAll(filepath.Dir(payload), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.CopyFS(payload, os.DirFS(source)); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(app, "Contents", "MacOS", "blackhole")
	root := payloadRoot(executable, "darwin")
	if root != payload {
		t.Fatalf("payload root = %s", root)
	}
	bundle, err := Load(root, encoded(manifest))
	if err != nil {
		t.Fatal(err)
	}
	if bundle.Client.Node != filepath.Join(payload, "bootstrap", "node.exe") {
		t.Fatal("bootstrap did not resolve from Resources")
	}
	if err := os.WriteFile(bundle.Client.Node, []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(root, encoded(manifest)); err == nil {
		t.Fatal("resource relocation bypassed Node pin verification")
	}
}

func TestUnbundledAndNonMacLayoutsStayAdjacent(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "blackhole")
	for _, platform := range []string{"darwin", "linux", "windows"} {
		if payloadRoot(exe, platform) != filepath.Dir(exe) {
			t.Fatal("unbundled layout changed")
		}
	}
	appExe := filepath.Join(t.TempDir(), "BlackHole.app", "Contents", "MacOS", "blackhole")
	if payloadRoot(appExe, "linux") != filepath.Dir(appExe) {
		t.Fatal("non-Mac layout changed")
	}
}
