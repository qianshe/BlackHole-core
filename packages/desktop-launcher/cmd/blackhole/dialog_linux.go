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

func showInfo(title, text string) {
	if p, err := exec.LookPath("zenity"); err == nil && exec.Command(p, "--info", "--title", title, "--text", text).Run() == nil {
		return
	}
	if p, err := exec.LookPath("kdialog"); err == nil && exec.Command(p, "--title", title, "--msgbox", text).Run() == nil {
		return
	}
	fmt.Fprintln(os.Stderr, title+": "+text)
}

// showConfirm is the native approval gate for maintenance; a cancelled or
// unavailable dialog is never approval.
func showConfirm(title, text string) bool {
	if p, err := exec.LookPath("zenity"); err == nil {
		return exec.Command(p, "--question", "--title", title, "--text", text).Run() == nil
	}
	if p, err := exec.LookPath("kdialog"); err == nil {
		return exec.Command(p, "--title", title, "--yesno", text).Run() == nil
	}
	return false
}
