//go:build windows

package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	webview2 "github.com/jchv/go-webview2"
)

// A finite real-HTTP reproduction, not NavigateToString/about:blank. No Core,
// real account, cloud URL, installed profile, or user data is accessed.
func TestNativeBridgeHTTP(t *testing.T) {
	if os.Getenv("BH_NATIVE_HTTP_TEST") != "1" {
		t.Skip("opt-in Windows native HTTP test")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	var mu sync.Mutex
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		w.Header().Set("Cache-Control", "no-store")
		if os.Getenv("BH_NATIVE_HTTP_COOP") == "1" {
			value := os.Getenv("BH_NATIVE_HTTP_COOP_VALUE")
			if value == "" {
				value = "same-origin"
			}
			w.Header().Set("Cross-Origin-Opener-Policy", value)
		}
		if os.Getenv("BH_NATIVE_HTTP_CSP") == "1" {
			w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'")
		}
		if r.URL.Path == "/probe.js" {
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			fmt.Fprint(w, `(() => {
                const state = {href:location.href, transport:typeof window.chrome?.webview?.postMessage,
                    stub:typeof window.blackholeDesktopWelcomeAction};
                document.body.innerText = JSON.stringify(state);
                if (state.transport === 'function') {
                    const rpc = window._rpc = window._rpc || {nextSeq:1};
                    rpc[999] = {resolve(){}, reject(){}};
                    window.chrome.webview.postMessage(JSON.stringify({id:999,method:'probe',params:[JSON.stringify(state)]}));
                }
            })();`)
			return
		}
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><html><body>Starting native HTTP probe<script src="/probe.js"></script></body></html>`)
	}))
	defer server.Close()
	profile, err := os.MkdirTemp("", "bh-native-http-")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		for i := 0; i < 30; i++ {
			if os.RemoveAll(profile) == nil {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Log("isolated WebView2 profile retained because its metrics process is still closing: " + profile)
	}()
	w := webview2.NewWithOptions(webview2.WebViewOptions{Debug: os.Getenv("BH_NATIVE_HTTP_DEBUG") == "1", DataPath: profile,
		WindowOptions: webview2.WindowOptions{Title: "BlackHole isolated HTTP probe", Width: 600, Height: 350}})
	if w == nil {
		t.Fatal("WebView2 unavailable")
	}
	defer w.Destroy()
	observations := make(chan string, 1)
	if err := w.Bind("probe", func(state string) error {
		select {
		case observations <- state:
		default:
		}
		w.Dispatch(func() { w.Terminate() })
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := w.Bind("blackholeDesktopWelcomeAction", func(action string) (string, error) {
		return `{"state":"logged_out","signIn":{"state":"idle"}}`, nil
	}); err != nil {
		t.Fatal(err)
	}
	timer := time.AfterFunc(7*time.Second, func() { w.Dispatch(func() { w.Terminate() }) })
	defer timer.Stop()
	w.Navigate(server.URL + "/")
	w.Run()
	mu.Lock()
	seen := strings.Join(paths, ",")
	mu.Unlock()
	t.Log("requested=" + seen)
	select {
	case got := <-observations:
		t.Log("native_http=" + got)
		if !strings.Contains(got, `"transport":"function"`) {
			t.Fatal("native HTTP transport missing")
		}
		if !strings.Contains(got, `"stub":"function"`) {
			t.Fatal("native Bind wrapper missing")
		}
	default:
		t.Fatal("real HTTP page did not deliver native message")
	}
}
