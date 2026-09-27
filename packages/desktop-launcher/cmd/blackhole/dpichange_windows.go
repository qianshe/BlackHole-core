package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procSetWindowLongPtrW = windows.NewLazySystemDLL("user32.dll").NewProc("SetWindowLongPtrW")
	procCallWindowProcW   = windows.NewLazySystemDLL("user32.dll").NewProc("CallWindowProcW")
	procSetWindowPos      = windows.NewLazySystemDLL("user32.dll").NewProc("SetWindowPos")
	prevWndProc           uintptr
	dpiWndProc            = windows.NewCallback(onWindowMessage)
)

const (
	wmDpiChanged  = 0x02E0
	gwlpWndProc   = ^uintptr(3) // GWLP_WNDPROC (-4)
	swpNoZOrder   = 0x0004
	swpNoActivate = 0x0010
)

// followDpiChanges resizes the window when it moves to a display with a
// different scale; the WebView re-renders itself at the new DPI.
func followDpiChanges(hwnd uintptr) {
	prevWndProc, _, _ = procSetWindowLongPtrW.Call(hwnd, gwlpWndProc, dpiWndProc)
}

func onWindowMessage(hwnd, msg, wparam, lparam uintptr) uintptr {
	if msg == wmDpiChanged && lparam != 0 {
		// lparam carries a RECT* from the OS (vet-clean reinterpretation of the uintptr).
		r := *(**struct{ Left, Top, Right, Bottom int32 })(unsafe.Pointer(&lparam))
		procSetWindowPos.Call(hwnd, 0, uintptr(r.Left), uintptr(r.Top), uintptr(r.Right-r.Left), uintptr(r.Bottom-r.Top), swpNoZOrder|swpNoActivate)
		return 0
	}
	ret, _, _ := procCallWindowProcW.Call(prevWndProc, hwnd, msg, wparam, lparam)
	return ret
}
