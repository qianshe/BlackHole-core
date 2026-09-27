package daemonctl

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOthersActiveAndTrayMarker(t *testing.T) {
	var marker string
	others := true
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/heartbeat":
			marker = r.Header.Get("x-blackhole-client")
			w.Write([]byte(`{"ok":true}`))
		case "/api/clients":
			if others {
				w.Write([]byte(`{"others_active":true}`))
			} else {
				w.Write([]byte(`{"others_active":false}`))
			}
		default:
			http.NotFound(w, r)
		}
	}))
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv.Listener = l
	srv.Start()
	defer srv.Close()
	c := Client{Port: l.Addr().(*net.TCPAddr).Port}
	if !c.Beat(context.Background()) || marker != "tray" {
		t.Fatalf("heartbeat must carry the tray marker, got %q", marker)
	}
	if !c.OthersActive(context.Background()) {
		t.Fatal("others_active true not read")
	}
	others = false
	if c.OthersActive(context.Background()) {
		t.Fatal("others_active false not read")
	}
	if (Client{Port: 1}).OthersActive(context.Background()) {
		t.Fatal("unreachable daemon must answer false (quit stops the daemon as before)")
	}
}
