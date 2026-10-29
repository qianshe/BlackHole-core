//go:build windows

package main

import (
	"errors"

	"blackhole/desktop-launcher/internal/distribution"
	"golang.org/x/sys/windows"
)

// holdInstallMutex marks only a native Desktop process (tray/window) as using
// the installed shell. Inno AppMutex refuses replacement until ALL holders exit.
// The independently running Core does not hold this mutex.
func holdInstallMutex() (func(), error) {
	b, err := distribution.Locate()
	if err != nil {
		return nil, err
	}
	name := "Local\\BlackHoleDesktopInstall"
	if b.Environment == "test" {
		name = "Local\\BlackHoleDesktopTestInstall"
	}
	ptr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateMutex(nil, false, ptr)
	if handle == 0 || (err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS)) {
		if handle != 0 {
			_ = windows.CloseHandle(handle)
		}
		return nil, errors.New("desktop_install_mutex_failed")
	}
	return func() { _ = windows.CloseHandle(handle) }, nil
}
