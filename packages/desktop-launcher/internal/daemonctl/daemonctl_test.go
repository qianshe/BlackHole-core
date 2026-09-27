package daemonctl

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func TestPortFromURL(t *testing.T) {
	if p, ok := PortFromURL("http://127.0.0.1:7306/ui/"); !ok || p != 7306 {
		t.Fatal(p, ok)
	}
	for _, bad := range []string{"http://example.com:80/", "http://127.0.0.1/ui/", "::"} {
		if _, ok := PortFromURL(bad); ok {
			t.Fatal(bad)
		}
	}
}

func serve(t *testing.T, h http.HandlerFunc) (*httptest.Server, int) {
	s := httptest.NewServer(h)
	t.Cleanup(s.Close)
	_, port, _ := net.SplitHostPort(s.Listener.Addr().String())
	p, _ := strconv.Atoi(port)
	return s, p
}

func TestWatchBeatsAndDetectsStop(t *testing.T) {
	var beats atomic.Int32
	s, port := serve(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/heartbeat" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		beats.Add(1)
		w.WriteHeader(200)
	})
	gone := make(chan struct{})
	go Client{Port: port}.Watch(context.Background(), 20*time.Millisecond, 3, func() { close(gone) })
	time.Sleep(90 * time.Millisecond)
	if beats.Load() < 3 {
		t.Fatalf("only %d beats", beats.Load())
	}
	s.Close() // daemon stopped elsewhere
	select {
	case <-gone:
	case <-time.After(3 * time.Second):
		t.Fatal("tray did not notice the daemon stopped")
	}
}

func TestWatchToleratesShortOutage(t *testing.T) {
	var n atomic.Int32
	_, port := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		if n.Add(1)%3 == 0 {
			w.WriteHeader(503)
			return
		}
		w.WriteHeader(200)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	Client{Port: port}.Watch(ctx, 10*time.Millisecond, 3, func() { t.Error("single misses must not stop the tray") })
}
