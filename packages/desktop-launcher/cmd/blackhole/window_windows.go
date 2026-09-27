package main

import (
	"path/filepath"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

var (
	user32                  = windows.NewLazySystemDLL("user32.dll")
	procFindWindowW         = user32.NewProc("FindWindowW")
	procShowWindow          = user32.NewProc("ShowWindow")
	procIsIconic            = user32.NewProc("IsIconic")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procSendMessageW        = user32.NewProc("SendMessageW")
	procCreateIconFromResEx = user32.NewProc("CreateIconFromResourceEx")
)

func showWindow(url string) error {
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus:     true,
		DataPath:      filepath.Join(dataDir(), "webview"),
		WindowOptions: webview2.WindowOptions{Title: windowTitle, Width: dpiScale(1280), Height: dpiScale(820), Center: true},
	})
	if w == nil {
		return errNoWebView // WebView2 runtime missing
	}
	defer w.Destroy()
	setWindowIcon(uintptr(w.Window()))
	followDpiChanges(uintptr(w.Window()))
	w.Navigate(url)
	w.Run()
	return nil
}

func setWindowIcon(hwnd uintptr) {
	for _, s := range []struct{ size, which int }{{32, 1}, {16, 0}} { // ICON_BIG, ICON_SMALL
		p := trayPNG(s.size)
		h, _, _ := procCreateIconFromResEx.Call(uintptr(unsafe.Pointer(&p[0])), uintptr(len(p)), 1, 0x00030000, uintptr(s.size), uintptr(s.size), 0)
		if h != 0 {
			procSendMessageW.Call(hwnd, 0x0080, uintptr(s.which), h) // WM_SETICON
		}
	}
}

// focusExistingWindow brings an open BlackHole window to the front.
func focusExistingWindow() bool {
	cls, _ := windows.UTF16PtrFromString("webview")
	title, _ := windows.UTF16PtrFromString(windowTitle)
	h, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(title)))
	if h == 0 {
		return false
	}
	if iconic, _, _ := procIsIconic.Call(h); iconic != 0 {
		procShowWindow.Call(h, 9) // SW_RESTORE
	}
	procSetForegroundWindow.Call(h)
	return true
}
