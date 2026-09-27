package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"blackhole/desktop-launcher/internal/bootstrap"
	"blackhole/desktop-launcher/internal/daemonctl"
)

// The app window runs in its own process (`blackhole --window`): the tray and
// the WebView each need the main thread's message loop.
const (
	windowTitle   = "BlackHole"
	exitNoWebView = 3
)

var errNoWebView = errors.New("webview unavailable")

// runWindowMode reads the ticket URL from stdin (never argv) and shows the window.
func runWindowMode() int {
	line, _ := bufio.NewReader(io.LimitReader(os.Stdin, 4096)).ReadString('\n')
	url := strings.TrimSpace(line)
	if !daemonctl.ValidWebURL(url) {
		return 2
	}
	if err := showWindow(url); err != nil {
		if errors.Is(err, errNoWebView) {
			return exitNoWebView
		}
		return 1
	}
	return 0
}

// openUI focuses the open window, or opens a new signed-in one. Without a
// WebView runtime it falls back to the default browser.
func openUI(ctx context.Context, rt bootstrap.Runtime, port int) {
	if focusExistingWindow() {
		return
	}
	url, err := daemonctl.Client{Port: port}.WebURL(ctx)
	if err != nil {
		showError("BlackHole", "无法打开 BlackHole 窗口。\n\n"+err.Error())
		return
	}
	if spawnWindow(url) == exitNoWebView {
		if r := bootstrap.Run(ctx, rt, nil, 60*time.Second); !r.OK {
			showError("BlackHole", describe(r))
		}
	}
}

// spawnWindow starts the window process and waits briefly for an early exit
// (missing WebView runtime); a window that stays open keeps running on its own.
func spawnWindow(url string) int {
	exe, err := selfExe()
	if err != nil {
		return exitNoWebView
	}
	cmd := exec.Command(exe, "--window")
	in, err := cmd.StdinPipe()
	if err != nil {
		return exitNoWebView
	}
	if err := cmd.Start(); err != nil {
		return exitNoWebView
	}
	_, _ = io.WriteString(in, url+"\n")
	_ = in.Close()
	done := make(chan int, 1)
	go func() {
		_ = cmd.Wait()
		done <- cmd.ProcessState.ExitCode()
	}()
	select {
	case code := <-done:
		return code
	case <-time.After(5 * time.Second):
		return 0
	}
}
