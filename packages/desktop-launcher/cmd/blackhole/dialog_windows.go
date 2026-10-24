//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var messageBoxW = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")

const (
	mbIconError   = 0x10
	mbIconInfo    = 0x40
	mbOKCancel    = 0x1
	mbIconExclaim = 0x30
	idOK          = 1
)

// showError uses MessageBoxW: release builds have no console (-H windowsgui).
func showError(title, text string) {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(text)
	_, _, _ = messageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), mbIconError)
}

func showInfo(title, text string) {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(text)
	_, _, _ = messageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), mbIconInfo)
}

// showConfirm is the native approval gate for maintenance. A Web page or tray
// click only reaches this dialog; it is never itself the confirmation.
func showConfirm(title, text string) bool {
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(text)
	r, _, _ := messageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), mbOKCancel|mbIconExclaim)
	return r == idOK
}
