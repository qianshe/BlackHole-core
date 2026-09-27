//go:build !windows

package bootstrap

import "os/exec"

const nodeName = "node"

func hideWindow(*exec.Cmd) {}
