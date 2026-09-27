//go:build !windows

package main

func platformIcon() []byte { return trayPNG(64) }
