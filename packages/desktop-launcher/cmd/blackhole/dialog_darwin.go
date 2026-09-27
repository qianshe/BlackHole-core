//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
)

// showError uses osascript (always present on macOS) and falls back to stderr.
func showError(title, text string) {
	script := fmt.Sprintf("display alert %s message %s as critical", strconv.Quote(title), strconv.Quote(text))
	if exec.Command("osascript", "-e", script).Run() != nil {
		fmt.Fprintln(os.Stderr, title+": "+text)
	}
}
