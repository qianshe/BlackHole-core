package main

import "golang.org/x/sys/windows"

// Without a DPI declaration Windows renders the window at 96 DPI and
// bitmap-stretches it on scaled displays (125%/150%), which blurs all text.
// Declare per-monitor v2 awareness before any window exists; older systems
// fall back to the Windows 8.1 / Vista APIs.
func init() {
	user32 := windows.NewLazySystemDLL("user32.dll")
	if p := user32.NewProc("SetProcessDpiAwarenessContext"); p.Find() == nil {
		const perMonitorAwareV2 = ^uintptr(3) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4)
		if r, _, _ := p.Call(perMonitorAwareV2); r != 0 {
			return
		}
	}
	if p := windows.NewLazySystemDLL("shcore.dll").NewProc("SetProcessDpiAwareness"); p.Find() == nil {
		if r, _, _ := p.Call(2); r == 0 { // PROCESS_PER_MONITOR_DPI_AWARE, S_OK
			return
		}
	}
	if p := user32.NewProc("SetProcessDPIAware"); p.Find() == nil {
		p.Call()
	}
}

// dpiScale converts a 96-DPI size to physical pixels for the primary display.
func dpiScale(v uint) uint {
	p := windows.NewLazySystemDLL("user32.dll").NewProc("GetDpiForSystem")
	if p.Find() != nil {
		return v
	}
	dpi, _, _ := p.Call()
	if dpi < 96 {
		return v
	}
	return v * uint(dpi) / 96
}
