//go:build !windows

package main

import (
	"errors"

	"blackhole/desktop-launcher/internal/distribution"
)

// Native updates are unsupported on these platforms; never stop Core for them.
func forceStopCoreForUpdate(distribution.Bundle, string) bool { return false }

func runUpdateHelper([]string) int { return 2 }
func handoffUpdate(string) error   { return errors.New("platform_updater_not_implemented") }
