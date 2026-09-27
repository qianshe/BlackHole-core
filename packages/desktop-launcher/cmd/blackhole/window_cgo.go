//go:build (darwin || linux) && cgo

package main

import webview "github.com/webview/webview_go"

func showWindow(url string) error {
	w := webview.New(false)
	if w == nil {
		return errNoWebView
	}
	defer w.Destroy()
	w.SetTitle(windowTitle)
	w.SetSize(1280, 820, webview.HintNone)
	w.Navigate(url)
	w.Run()
	return nil
}

// Not implemented on macOS/Linux yet: a second launch opens another window.
func focusExistingWindow() bool { return false }
