//go:build windows

package bootstrap

import (
	"os/exec"
	"syscall"
)

const nodeName = "node.exe"

const createNoWindow = 0x08000000

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
