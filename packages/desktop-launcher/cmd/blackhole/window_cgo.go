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
	if desktopCoreActionHandler != nil {
		_ = w.Bind("blackholeDesktopCoreAction", func(action string, revision float64) (string, error) {
			var rev *int
			if revision >= 0 {
				value := int(revision)
				rev = &value
			}
			completed, err := desktopCoreActionHandler(action, rev)
			if err != nil {
				return "", err
			}
			if completed {
				return `{"completed":true}`, nil
			}
			return `{"completed":false}`, nil
		})
	}
	reloadManagedWindow = func(next string) { w.Dispatch(func() { w.Navigate(next) }) }
	defer func() { reloadManagedWindow = nil }()
	w.Navigate(url)
	w.Run()
	return nil
}

// Window discovery/closing is not implemented on macOS/Linux yet; a peer
// lease there still blocks maintenance authoritatively instead of being
// bypassed.
func closeManagedWindow() bool { return false }

// Not implemented on macOS/Linux yet: a second launch opens another window.
func focusExistingWindow() bool { return false }
