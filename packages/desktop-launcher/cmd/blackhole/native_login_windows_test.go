//go:build windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"

	"blackhole/desktop-launcher/internal/daemonctl"
)

// Driven by native-webview-welcome.test.mjs. Uses production showWindow with
// its persistent profile, window styling and actual native Core account client.
// Only cloud responses and the system-browser opener are synthetic in the
// isolated daemon; the page, Go binding and Core sign-in service are real.
func TestNativeLoginWindow(t *testing.T) {
	target := os.Getenv("BH_NATIVE_LOGIN_URL")
	if target == "" {
		t.Skip("isolated Windows integration driver only")
	}
	u, err := url.Parse(target)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Path != "/desktop/" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		t.Fatal("invalid isolated native URL")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || port == 7306 || port == 17306 {
		t.Fatal("production/test-installed ports are forbidden")
	}
	dir := os.Getenv("BH_NATIVE_LOGIN_PROFILE")
	if dir == "" {
		t.Fatal("isolated profile required")
	}
	oldStateDir, oldDataDir, oldTitle := managedStateDir, managedUserDataDir, windowTitle
	oldWelcomeHandler := desktopWelcomeActionHandler
	// showWindow derives the WebView profile from dataDir(), which uses the
	// managed user-data root independently of the coordination state directory.
	managedStateDir = dir
	managedUserDataDir = dir
	windowTitle = fmt.Sprintf("BlackHole Native Login Test · %d", port)
	defer func() {
		managedStateDir, managedUserDataDir, windowTitle = oldStateDir, oldDataDir, oldTitle
		desktopWelcomeActionHandler = oldWelcomeHandler
	}()
	desktopWelcomeActionHandler = func(action string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		client := daemonctl.Client{Port: port}
		var result daemonctl.WelcomeStatus
		var err error
		if action == "status" {
			result, err = client.Welcome(ctx)
		} else {
			result, err = client.LoginAction(ctx, action)
		}
		if err != nil {
			return "", err
		}
		b, err := json.Marshal(result)
		return string(b), err
	}
	done := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			if scanner.Text() == "close" {
				closeManagedWindow()
				return
			}
		}
	}()
	// Leave time for the real Core observation backoff and the same-window
	// recovery assertion; the JS driver closes this window normally on success.
	timer := time.AfterFunc(105*time.Second, func() { closeManagedWindow() })
	defer timer.Stop()
	if err := showWindow(target); err != nil {
		t.Fatal(err)
	}
	close(done)
	t.Log("NATIVE_LOGIN_WINDOW_CLOSED")
}
