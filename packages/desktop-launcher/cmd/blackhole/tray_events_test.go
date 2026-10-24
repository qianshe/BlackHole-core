package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"blackhole/desktop-launcher/internal/daemonctl"
)

func TestTrayQuitIsLocalAndTerminal(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	quit := make(chan struct{}, 2)
	quit <- struct{}{}
	quit <- struct{}{}
	calls := 0
	unexpected := func() { t.Error("quit must not invoke open/autostart actions") }
	watchTrayActions(ctx, nil, nil, quit, unexpected, unexpected, func() { calls++ })
	if calls != 1 {
		t.Fatalf("want exactly one local exit, got %d", calls)
	}
}

func TestTrayActionsPreserveOpenAndAutostart(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	open, auto, quit := make(chan struct{}, 1), make(chan struct{}, 1), make(chan struct{}, 1)
	open <- struct{}{}
	var actions []string
	watchTrayActions(ctx, open, auto, quit,
		func() { actions = append(actions, "open"); auto <- struct{}{} },
		func() { actions = append(actions, "auto"); quit <- struct{}{} },
		func() { actions = append(actions, "quit") },
	)
	if got := strings.Join(actions, ","); got != "open,auto,quit" {
		t.Fatal(got)
	}
}

func TestTrayAlreadyCancelledDoesNotDispatch(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	quit := make(chan struct{}, 1)
	quit <- struct{}{}
	unexpected := func() { t.Error("cancelled tray must not dispatch actions") }
	watchTrayActions(ctx, nil, nil, quit, unexpected, unexpected, unexpected)
}

func TestTrayQuitKeepsDaemonReachable(t *testing.T) {
	// This is only an isolated HTTP fixture, never a real daemon or Core store.
	beat := make(chan struct{})
	var once sync.Once
	var forbidden atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/heartbeat":
			once.Do(func() { close(beat) })
			w.WriteHeader(http.StatusOK)
		case "/api/health":
			w.WriteHeader(http.StatusOK)
		default:
			// Includes /clients, /shutdown and /restart. Exit must not query
			// other clients even when that endpoint is unavailable.
			forbidden.Add(1)
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer srv.Close()
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	watchDone := make(chan struct{})
	var gone atomic.Int32
	go func() {
		defer close(watchDone)
		daemonctl.Client{Port: port}.Watch(ctx, time.Hour, 1, func() { gone.Add(1) })
	}()
	select {
	case <-beat:
	case <-ctx.Done():
		t.Fatal("heartbeat did not start")
	}
	quit := make(chan struct{}, 1)
	quit <- struct{}{}
	unexpected := func() { t.Error("unexpected tray action") }
	watchTrayActions(ctx, nil, nil, quit, unexpected, unexpected, cancel)
	select {
	case <-watchDone:
	case <-time.After(time.Second):
		t.Fatal("tray heartbeat did not detach")
	}
	res, err := srv.Client().Get(srv.URL + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK || forbidden.Load() != 0 || gone.Load() != 0 {
		t.Fatalf("exit affected daemon: health=%d forbidden=%d gone=%d", res.StatusCode, forbidden.Load(), gone.Load())
	}
}

func TestTrayWiringDoesNotRegainStopAuthority(t *testing.T) {
	// Lock down the native wiring too: the event-loop tests must not pass
	// while the real menu reintroduces the legacy query-then-stop branch.
	body, err := os.ReadFile("tray.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	for _, forbidden := range []string{"OthersActive(", "bootstrap.Run(", "--stop", "/shutdown", "/restart", "os/exec"} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("tray regained daemon lifecycle authority: %s", forbidden)
		}
	}
	if !strings.Contains(source, "watchTrayActions(") || !strings.Contains(source, "systray.Quit,") {
		t.Fatal("native menu must wire local Quit to the tested event loop")
	}
}
