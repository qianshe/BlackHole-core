//go:build !windows && !cgo

package main

// Builds without cgo have no WebView: openUI falls back to the browser.
func showWindow(string) error   { return errNoWebView }
func focusExistingWindow() bool { return false }
