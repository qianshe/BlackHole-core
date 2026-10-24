//go:build !windows

package main

import "errors"

func runUpdateHelper([]string) int { return 2 }
func handoffUpdate(string) error   { return errors.New("platform_updater_not_implemented") }
