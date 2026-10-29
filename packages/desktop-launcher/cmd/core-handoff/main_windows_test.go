//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestOwnedListenerLookup(t *testing.T) {
	l, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	owner, e := listenerPID(uint16(l.Addr().(*net.TCPAddr).Port))
	if e != nil || owner != uint32(os.Getpid()) {
		t.Fatalf("listener not owned by fixture: %d %v", owner, e)
	}
}
func TestHandoffFixtureChild(t *testing.T) {
	if os.Getenv("BH_HANDOFF_FIXTURE") != "1" {
		return
	}
	port, e := strconv.Atoi(os.Getenv("BH_HANDOFF_PORT"))
	if e != nil {
		t.Fatal(e)
	}
	l, e := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	fmt.Println("READY")
	_ = http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "lifecycle_state": "managed",
			"daemon_id": "fixture-daemon", "start_fingerprint": "fixture-fingerprint",
			"descriptor_hash": strings.Repeat("a", 64), "data_root_id": strings.Repeat("b", 64)})
	}))
}
func TestOnlyMatchingFixtureIsAffected(t *testing.T) {
	l, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := uint16(l.Addr().(*net.TCPAddr).Port)
	l.Close()
	exe, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	child := exec.Command(exe, "-test.run=^TestHandoffFixtureChild$")
	child.Env = append(os.Environ(), "BH_HANDOFF_FIXTURE=1", "BH_HANDOFF_PORT="+strconv.Itoa(int(port)))
	out, e := child.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	if e = child.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() {
		if child.ProcessState == nil {
			_ = child.Process.Kill()
			_ = child.Wait()
		}
	}()
	ready := make(chan string, 1)
	go func() { line, _ := bufio.NewReader(out).ReadString('\n'); ready <- line }()
	select {
	case line := <-ready:
		if !strings.Contains(line, "READY") {
			t.Fatalf("fixture did not listen: %q", line)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("fixture startup timed out")
	}
	pid := uint32(child.Process.Pid)
	identity := expectedIdentity{"fixture-daemon", "fixture-fingerprint", strings.Repeat("a", 64), strings.Repeat("b", 64)}
	if execute(pid, port, filepath.Join(filepath.Dir(exe), "unrelated.exe"), identity, false) == nil {
		t.Fatal("wrong exe accepted")
	}
	bad := identity
	bad.descriptorHash = strings.Repeat("c", 64)
	if execute(pid, port, exe, bad, false) == nil {
		t.Fatal("wrong signed daemon identity accepted")
	}
	if execute(pid, port, exe, identity, true) != nil {
		t.Fatal("read-only verified fixture refused")
	}
	if execute(pid, port, exe, identity, false) != nil {
		t.Fatal("verified fixture not stopped")
	}
	if child.Wait() == nil {
		t.Fatal("expected a nonzero intentional fixture exit")
	}
	if _, e = listenerPID(port); e == nil {
		t.Fatal("stopped child still holds port")
	}
}
