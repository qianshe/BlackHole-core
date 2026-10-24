package coremanager

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Opt-in cross-language test. The smoke driver creates a fresh isolated user,
// verified Store and random non-production port before starting this test exe.
func TestIsolatedManagerCLI(t *testing.T) {
	file := os.Getenv("BH_DESKTOP_MANAGER_SMOKE_CONFIG")
	if file == "" {
		t.Skip("run scripts/desktop-manager-smoke.mjs with an isolated test Seed")
	}
	root := filepath.Dir(file)
	if !filepath.IsAbs(file) || !strings.HasPrefix(filepath.Base(root), "bh-desktop-manager-smoke-") {
		t.Fatal("isolated smoke root required")
	}
	var config struct {
		Node, Entry, Store, TrustConfig string
		Port                            int
	}
	body, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if err = decode(body, &config); err != nil {
		t.Fatal(err)
	}
	if config.Port == 7306 || config.Port < 1 || config.Port > 65535 {
		t.Fatal("non-production port required")
	}
	for _, p := range []string{config.Node, config.Store, config.TrustConfig, os.Getenv("BLACKHOLE_HOME"), os.Getenv("BLACKHOLE_DB"), os.Getenv("USERPROFILE"), os.Getenv("LOCALAPPDATA")} {
		rel, err := filepath.Rel(root, p)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			t.Fatal("path escaped isolated test root")
		}
	}
	c := Client{Node: config.Node, Entry: config.Entry, Store: config.Store, TrustConfig: config.TrustConfig, Timeout: 90 * time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	first, err := c.Attach(ctx, testHost(), config.Port)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Spawned {
		t.Fatal("fresh isolated store should start exactly one daemon")
	}
	otherHost := testHost()
	otherHost.ClientID = "vscode"
	otherHost.Kind = "vscode"
	otherHost.InstanceID = "33333333-3333-4333-8333-333333333333"
	other, err := c.Attach(ctx, otherHost, config.Port)
	if err != nil {
		t.Fatal(err)
	}
	if other.Spawned || other.Receipt.DaemonID != first.Receipt.DaemonID || other.Receipt.DataRootID != first.Receipt.DataRootID || other.Receipt.DescriptorHash != first.Receipt.DescriptorHash {
		t.Fatal("clients did not converge on the same Core/data/daemon")
	}
	if _, err = c.Heartbeat(ctx, first.Lease.Handle(), config.Port); err != nil {
		t.Fatal(err)
	}
	exitCtx, exitCancel := context.WithCancel(ctx)
	exitCancel()
	if err = c.KeepAlive(exitCtx, first.Lease.Handle(), config.Port); err != nil {
		t.Fatal(err)
	}
	if _, err = c.Heartbeat(ctx, other.Lease.Handle(), config.Port); err != nil {
		t.Fatal("Desktop detach disturbed VS Code", err)
	}
	if err = c.Detach(ctx, other.Lease.Handle()); err != nil {
		t.Fatal(err)
	}
	res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://127.0.0.1:" + strconv.Itoa(config.Port) + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var health struct {
		DaemonID string `json:"daemon_id"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 256*1024)).Decode(&health) != nil || health.DaemonID != first.Receipt.DaemonID {
		t.Fatal("last client detach stopped or replaced Core")
	}
	result, _ := json.Marshal(map[string]any{"ok": true, "daemonId": first.Receipt.DaemonID, "descriptorHash": first.Receipt.DescriptorHash, "dataRootId": first.Receipt.DataRootID, "sameDaemon": true, "sameCore": true, "quitPreservedDaemon": true})
	t.Log("DESKTOP_MANAGER_SMOKE=" + string(result))
}
