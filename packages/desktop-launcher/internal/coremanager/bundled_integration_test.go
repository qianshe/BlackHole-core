package coremanager

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Driven by the JS acceptance runner using an isolated HOME, signed VSIX
// Manager and real Core. This is the actual Go client, not a JS 'desktop' tag.
func TestAutomaticBundledCrossHost(t *testing.T) {
	file := os.Getenv("BH_BUNDLED_HOST_TEST_CONFIG")
	if file == "" {
		t.Skip("isolated automatic bundled-host driver required")
	}
	root := filepath.Dir(file)
	if !filepath.IsAbs(file) || !strings.HasPrefix(filepath.Base(root), "bh-bundled-host-") {
		t.Fatal("isolated root required")
	}
	var config struct {
		Node, Entry, Store, TrustConfig, OldArchive, OldHash, OldVersion, Version string
		Port                                                                      int
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if err = decode(raw, &config); err != nil {
		t.Fatal(err)
	}
	if config.Port == 7306 || config.Port < 1024 {
		t.Fatal("isolated port required")
	}
	for _, p := range []string{config.Entry, config.Store, config.TrustConfig, config.OldArchive, os.Getenv("BLACKHOLE_HOME"), os.Getenv("BLACKHOLE_DB"), os.Getenv("USERPROFILE")} {
		rel, e := filepath.Rel(root, p)
		if e != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			t.Fatal("escaped isolated root")
		}
	}
	c := Client{Node: config.Node, Entry: config.Entry, Store: config.Store, TrustConfig: config.TrustConfig, Timeout: 90 * time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 95*time.Second)
	defer cancel()
	host := testHost()
	host.Version = config.Version
	first, err := c.StartBundled(ctx, host, config.Port, config.OldArchive, config.OldHash, testUUID)
	if err != nil {
		t.Fatal(err)
	}
	if config.OldVersion == "" || first.Attachment.Receipt.RuntimeVersion != config.OldVersion || !first.Attachment.Spawned {
		t.Fatal("old signed runtime was not started", first.State)
	}
	write := func(name string, value any) {
		b, e := json.Marshal(value)
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(filepath.Join(root, name), b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	write("desktop-ready.json", first.Attachment.Receipt)
	signal := filepath.Join(root, "vscode-updated.json")
	deadline := time.Now().Add(60 * time.Second)
	for {
		if _, e := os.Stat(signal); e == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("VS Code automatic startup did not complete")
		}
		time.Sleep(100 * time.Millisecond)
	}
	next, err := c.RestoreAttachment(ctx, host, first.Attachment, config.Port)
	if err != nil {
		t.Fatal(err)
	}
	if next.Spawned || next.Receipt.RuntimeVersion != config.Version || next.Receipt.DaemonID == first.Attachment.Receipt.DaemonID || next.Receipt.DataRootID != first.Attachment.Receipt.DataRootID {
		t.Fatal("peer reconnection failed")
	}
	if _, err = c.Heartbeat(ctx, next.Lease.Handle(), config.Port); err != nil {
		t.Fatal(err)
	}
	if err = c.Detach(ctx, next.Lease.Handle()); err != nil {
		t.Fatal(err)
	}
	write("desktop-reconnected.json", map[string]any{"ok": true, "version": next.Receipt.RuntimeVersion, "daemonId": next.Receipt.DaemonID, "spawned": next.Spawned, "actualGoClient": true})
}
