package daemonctl

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

const tk = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456"

func TestWebURL(t *testing.T) {
	_, port := serve(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/web/bootstrap" {
			w.WriteHeader(404)
			return
		}
		w.Write([]byte(`{"ticket":"` + tk + `","path":"/ui/"}`))
	})
	u, err := Client{Port: port}.WebURL(context.Background())
	if err != nil || !strings.HasSuffix(u, "/ui/#"+tk) || !ValidWebURL(u) {
		t.Fatal(u, err)
	}
}

func TestWebURLOldDaemon(t *testing.T) {
	_, port := serve(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) })
	if _, err := (Client{Port: port}).WebURL(context.Background()); err == nil || !strings.Contains(err.Error(), "更新") {
		t.Fatal(err)
	}
}

func TestValidWebURL(t *testing.T) {
	for _, bad := range []string{
		"https://evil.example/ui/#" + tk,
		"http://127.0.0.1:7306/ui/#short",
		"http://127.0.0.1:7306/other/#" + tk,
		"http://127.0.0.1:0/ui/#" + tk,
		"file:///C:/x.html",
	} {
		if ValidWebURL(bad) {
			t.Fatal(bad)
		}
	}
	if !ValidWebURL("http://127.0.0.1:7306/ui/#" + tk) {
		t.Fatal("good url rejected")
	}
}
