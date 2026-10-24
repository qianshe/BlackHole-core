//go:build !windows

package coremanager

import "os/exec"

func hideWindow(*exec.Cmd) {}
