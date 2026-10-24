//go:build !windows

package main

// Non-Windows packaging uses the platform's own update/quit mechanism.
func holdInstallMutex() (func(), error) { return func() {}, nil }
