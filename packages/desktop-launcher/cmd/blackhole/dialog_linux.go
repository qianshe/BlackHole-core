//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
)

// showError tries common desktop dialog tools, then stderr.
func showError(title, text string) {
	if p, err := exec.LookPath("zenity"); err == nil && exec.Command(p, "--error", "--title", title, "--text", text).Run() == nil {
		return
	}
	if p, err := exec.LookPath("kdialog"); err == nil && exec.Command(p, "--title", title, "--error", text).Run() == nil {
		return
	}
	fmt.Fprintln(os.Stderr, title+": "+text)
}
