package bootstrap

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func fakeEnv(files map[string]bool, env map[string]string, exeDir, cwd string) Env {
	return Env{
		Getenv:   func(k string) string { return env[k] },
		LookPath: func(string) (string, error) { return "", errors.New("not found") },
		Exists:   func(p string) bool { return files[filepath.Clean(p)] },
		ExeDir:   exeDir,
		Cwd:      cwd,
		NodeName: "node",
	}
}

func TestLocateReleaseLayout(t *testing.T) {
	root := filepath.FromSlash("/app")
	files := map[string]bool{
		filepath.Join(root, "runtime", "node"):             true,
		filepath.Join(root, "runtime", "bootstrap.cjs"):    true,
		filepath.Join(root, "runtime", "daemon", "cli.js"): true,
	}
	rt, err := Locate(fakeEnv(files, nil, root, filepath.FromSlash("/elsewhere")))
	if err != nil {
		t.Fatal(err)
	}
	if rt.Node != filepath.Join(root, "runtime", "node") || rt.Bootstrap != filepath.Join(root, "runtime", "bootstrap.cjs") {
		t.Fatalf("unexpected runtime %+v", rt)
	}
}

func TestLocateDevCheckoutFromCwd(t *testing.T) {
	repo := filepath.FromSlash("/src/blackhole")
	node := filepath.FromSlash("/usr/bin/node")
	files := map[string]bool{
		node: true,
		filepath.Join(repo, "packages", "host-runtime", "dist", "bootstrap.cjs"): true,
		filepath.Join(repo, "dist", "cli.js"):                                    true,
	}
	env := fakeEnv(files, map[string]string{"BLACKHOLE_NODE": node}, filepath.FromSlash("/tmp/build"), filepath.Join(repo, "packages", "desktop-launcher"))
	rt, err := Locate(env)
	if err != nil {
		t.Fatal(err)
	}
	if rt.DaemonEntry != filepath.Join(repo, "dist", "cli.js") {
		t.Fatalf("unexpected daemon entry %q", rt.DaemonEntry)
	}
}

func TestLocateMissing(t *testing.T) {
	_, err := Locate(fakeEnv(map[string]bool{}, nil, filepath.FromSlash("/app"), filepath.FromSlash("/app")))
	if !errors.Is(err, ErrAssetMissing) {
		t.Fatalf("want ErrAssetMissing, got %v", err)
	}
}

func TestParse(t *testing.T) {
	ok, err := Parse([]byte("{\"ok\":true,\"browserOpened\":true,\"receipt\":{\"daemonVersion\":\"1\",\"localUrl\":\"http://127.0.0.1:1/ui/\"}}\n"))
	if err != nil || !ok.OK || ok.Receipt.LocalURL == "" {
		t.Fatalf("ok parse: %+v %v", ok, err)
	}
	fail, err := Parse([]byte(`{"ok":false,"code":"port_conflict","message":"x"}`))
	if err != nil || fail.Code != "port_conflict" {
		t.Fatalf("fail parse: %+v %v", fail, err)
	}
	for _, bad := range []string{"", "not json", `{"ok":false}`, `{"ok":true}`, strings.Repeat("x", MaxResultBytes+1)} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Fatalf("expected error for %.20q", bad)
		}
	}
}

func TestLimitWriter(t *testing.T) {
	w := &limitWriter{n: 4}
	n, _ := w.Write([]byte("abcdef"))
	if n != 6 || w.buf.String() != "abcd" {
		t.Fatalf("got %d %q", n, w.buf.String())
	}
}

func TestParseStopResult(t *testing.T) {
	for _, line := range []string{`{"ok":true,"stopped":true}`, `{"ok":true,"stopped":false,"code":"not_running"}`} {
		r, err := Parse([]byte(line))
		if err != nil || !r.OK {
			t.Fatalf("%s: %v %+v", line, err, r)
		}
	}
	if _, err := Parse([]byte(`{"ok":true}`)); err == nil {
		t.Fatal("launch success without receipt must still be rejected")
	}
}
