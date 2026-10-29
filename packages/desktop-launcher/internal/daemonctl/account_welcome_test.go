package daemonctl

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
)

func TestNativeWelcomeUsesOnlyFixedCoreAccountRoutes(t *testing.T) {
	var signins, cancels, checks atomic.Int32
	_, port := serve(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/account/welcome":
			if r.Method != http.MethodGet {
				t.Errorf("status used %s", r.Method)
			}
			fmt.Fprint(w, `{"state":"logged_out","signIn":{"state":"idle"}}`)
		case "/api/account/sign-in":
			if r.Method != http.MethodPost {
				t.Errorf("sign-in used %s", r.Method)
			}
			signins.Add(1)
			fmt.Fprint(w, "{}")
		case "/api/account/sign-in/cancel":
			if r.Method != http.MethodPost {
				t.Errorf("cancel used %s", r.Method)
			}
			cancels.Add(1)
			fmt.Fprint(w, "{}")
		case "/api/account/call":
			if r.Method != http.MethodPost {
				t.Errorf("verify used %s", r.Method)
			}
			var buf [128]byte
			count, _ := r.Body.Read(buf[:])
			if string(buf[:count]) != `{"method":"check","args":[]}` {
				t.Errorf("verify must be a fixed check-only request: %q", buf[:count])
			}
			checks.Add(1)
			fmt.Fprint(w, "{}")
		default:
			t.Errorf("unexpected route %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	})
	client := Client{Port: port}
	ctx := context.Background()
	a, err := client.Welcome(ctx)
	if err != nil || a.State != "logged_out" || a.SignIn.State != "idle" {
		t.Fatal(a, err)
	}
	for _, operation := range []string{"sign-in", "cancel", "verify"} {
		if _, err := client.LoginAction(ctx, operation); err != nil {
			t.Fatal(operation, err)
		}
	}
	if signins.Load() != 1 || cancels.Load() != 1 || checks.Load() != 1 {
		t.Fatal("unexpected native account actions")
	}
	for _, input := range []string{"", "open-url", "https://untrusted.example", "sign-out", "stop"} {
		if _, err := client.LoginAction(ctx, input); err == nil {
			t.Fatalf("accepted %q", input)
		}
	}
}

func TestNativeWelcomeRejectsUnexpectedStatus(t *testing.T) {
	_, port := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"state":"bypassed","signIn":{"state":"idle"},"token":"should-not-escape"}`)
	})
	if _, err := (Client{Port: port}).Welcome(context.Background()); err == nil {
		t.Fatal("a bad or credential-bearing state must fail closed")
	}
}

func TestNativeWelcomeURLRequiresLocalFixedPort(t *testing.T) {
	for _, port := range []int{-1, 0, 65536} {
		if _, err := (Client{Port: port}).WelcomeURL(); err == nil {
			t.Fatal(port)
		}
	}
	url, err := (Client{Port: 17308}).WelcomeURL()
	if err != nil || url != "http://127.0.0.1:17308/desktop/" || !ValidWebURL(url) {
		t.Fatal(url, err)
	}
	for _, bad := range []string{
		"http://127.0.0.1:17308/#",
		"http://127.0.0.1:17308/#not-desktop",
		"http://127.0.0.1:17308/ui/",
		"http://127.0.0.1:17308/?x=1",
		"http://127.0.0.1:17308/ui/?x=1",
		"http://127.0.0.1:17308/ui/#",
		"http://127.0.0.1:17308/ui/../api",
		"http://localhost:17308/ui/",
	} {
		if ValidWebURL(bad) {
			t.Fatalf("unsafe welcome URL: %s", bad)
		}
	}
}
