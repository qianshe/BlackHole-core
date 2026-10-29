//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// showError uses osascript (always present on macOS) and falls back to stderr.
func showError(title, text string) {
	script := fmt.Sprintf("display alert %s message %s as critical", strconv.Quote(title), strconv.Quote(text))
	if exec.Command("osascript", "-e", script).Run() != nil {
		fmt.Fprintln(os.Stderr, title+": "+text)
	}
}

func showInfo(title, text string) {
	script := fmt.Sprintf("display alert %s message %s", strconv.Quote(title), strconv.Quote(text))
	if exec.Command("osascript", "-e", script).Run() != nil {
		fmt.Fprintln(os.Stderr, title+": "+text)
	}
}

// showConfirm is the native approval gate for maintenance; a cancelled or
// unavailable dialog is never approval.
func showConfirm(title, text string) bool {
	script := fmt.Sprintf("display dialog %s with title %s buttons {\"取消\", \"确定\"} default button \"取消\"", strconv.Quote(text), strconv.Quote(title))
	out, err := exec.Command("osascript", "-e", script).Output()
	return err == nil && strings.Contains(string(out), "确定")
}
