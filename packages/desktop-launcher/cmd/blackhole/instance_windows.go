package main

import (
	"strconv"

	"golang.org/x/sys/windows"
)

// acquireTray returns false when another tray already serves this port.
// The mutex is released by the OS when the process exits.
func acquireTray(port int) bool {
	name, _ := windows.UTF16PtrFromString("Local\\BlackHoleTray-" + strconv.Itoa(port))
	_, err := windows.CreateMutex(nil, false, name)
	return err != windows.ERROR_ALREADY_EXISTS && err == nil
}
