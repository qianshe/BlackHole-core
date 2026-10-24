package main

import (
	"fmt"
	"path/filepath"
	"runtime"
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
	procPostMessageW        = user32.NewProc("PostMessageW")
	procCreateIconFromResEx = user32.NewProc("CreateIconFromResourceEx")
	procLoadImageW          = user32.NewProc("LoadImageW")
	procGetModuleHandleW    = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW")
	// DWM attributes style only the native caption, preserving drag, resize
	// and the standard Windows window-control buttons.
	procDwmSetWindowAttribute = windows.NewLazySystemDLL("dwmapi.dll").NewProc("DwmSetWindowAttribute")
)

func showWindow(url string) error {
	// WebView2 is an STA/COM UI. The native host must remain on the same OS
	// thread from environment creation through Bind, Init, Navigate and Run.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
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
	styleWindowCaption(uintptr(w.Window()))
	followDpiChanges(uintptr(w.Window()))
	if desktopWelcomeActionHandler != nil {
		if err := bindDesktopWelcomeBridge(w); err != nil {
			showError("BlackHole", "无法加载 Desktop 登录通道："+err.Error())
			return fmt.Errorf("desktop_welcome_bind_failed: %w", err)
		}
	}
	bindDesktopCoreBridge(w)
	// This bridge can only read state/check versions. Downloads and installation
	// remain in the single tray and always require native confirmation.
	if err := w.Bind("blackholeDesktopUpdateAction", desktopUpdateAction); err != nil {
		return fmt.Errorf("desktop_update_bridge_failed: %w", err)
	}
	reloadManagedWindow = func(next string) { w.Dispatch(func() { w.Navigate(next) }) }
	defer func() { reloadManagedWindow = nil }()
	w.Navigate(url)
	w.Run()
	return nil
}

// bindDesktopCoreBridge exposes exactly one whitelisted native entry to the
// daemon-served page. The page supplies only an action name and, for
// apply-settings, the revision it displayed; confirmation, target binding and
// the Manager transaction all stay native. A cancelled dialog reports
// completed=false, never an error disguised as success.
// A native-only welcome bridge. The fixed action set cannot supply URLs,
// token material, machine targets or arguments to the daemon.
func bindDesktopWelcomeBridge(w webview2.WebView) error {
	return w.Bind("blackholeDesktopWelcomeAction", func(action string) (string, error) {
		return desktopWelcomeActionHandler(action)
	})
}

func bindDesktopCoreBridge(w webview2.WebView) {
	if desktopCoreActionHandler == nil {
		return
	}
	_ = w.Bind("blackholeDesktopCoreAction", func(action string, revision float64) (string, error) {
		var rev *int
		if revision >= 0 {
			value := int(revision)
			rev = &value
		}
		completed, err := desktopCoreActionHandler(action, rev)
		if err != nil {
			return "", err
		}
		if completed {
			return `{"completed":true}`, nil
		}
		return `{"completed":false}`, nil
	})
}

// DWMWA_USE_IMMERSIVE_DARK_MODE (20) works on recent Windows 10/11.
// DWMWA_*_COLOR (34-36) are Windows 11+ enhancements. Unsupported attributes
// are simply ignored; do not replace native non-client frame handling.
type captionAttribute struct {
	id    uintptr
	value uint32
}

func darkCaptionAttributes() []captionAttribute {
	return []captionAttribute{
		{20, 1},          // dark caption and caption buttons (BOOL)
		{35, 0x00181818}, // caption background: RGB(24,24,24), COLORREF
		{36, 0x00F2F2F2}, // caption text: RGB(242,242,242)
		{34, 0x00303031}, // narrow window border: RGB(49,48,48), COLORREF
	}
}

// applyCaptionAttributes is a narrow seam for testing the intended native
// appearance without creating/mutating a real user's desktop window.
func applyCaptionAttributes(hwnd uintptr, apply func(hwnd, id uintptr, value uint32)) {
	if hwnd == 0 {
		return
	}
	for _, a := range darkCaptionAttributes() {
		apply(hwnd, a.id, a.value)
	}
}

func styleWindowCaption(hwnd uintptr) {
	if hwnd == 0 || procDwmSetWindowAttribute.Find() != nil {
		return
	}
	applyCaptionAttributes(hwnd, func(hwnd, id uintptr, value uint32) {
		// HRESULT is intentionally ignored: older Windows builds may not
		// recognize all attributes, but the normal titlebar remains usable.
		procDwmSetWindowAttribute.Call(hwnd, id, uintptr(unsafe.Pointer(&value)), unsafe.Sizeof(value))
	})
}

func setWindowIcon(hwnd uintptr) {
	if hwnd == 0 {
		return
	}
	module, _, _ := procGetModuleHandleW.Call(0)
	for _, size := range []struct{ pixels, which int }{{32, 1}, {16, 0}} { // ICON_BIG, ICON_SMALL
		// Use the same embedded RT_GROUP_ICON #1 as the taskbar and Start menu.
		// LR_SHARED gives the icon the lifetime of the loaded executable module.
		var icon uintptr
		if module != 0 {
			icon, _, _ = procLoadImageW.Call(module, 1, 1, uintptr(size.pixels), uintptr(size.pixels), 0x8000) // IMAGE_ICON / LR_SHARED
		}
		if icon == 0 { // Dev builds without Windows PE resources still show the tray mark.
			png := trayPNG(size.pixels)
			icon, _, _ = procCreateIconFromResEx.Call(
				uintptr(unsafe.Pointer(&png[0])), uintptr(len(png)), 1, 0x00030000,
				uintptr(size.pixels), uintptr(size.pixels), 0,
			)
		}
		if icon != 0 {
			procSendMessageW.Call(hwnd, 0x0080, uintptr(size.which), icon) // WM_SETICON
		}
	}
}

// closeManagedWindow asks our own open window to close through its normal
// message loop, so the window process detaches its lease on exit. It never
// terminates the window process.
func closeManagedWindow() bool {
	cls, _ := windows.UTF16PtrFromString("webview")
	title, _ := windows.UTF16PtrFromString(windowTitle)
	h, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(title)))
	if h == 0 {
		return false
	}
	procPostMessageW.Call(h, 0x0010, 0, 0) // WM_CLOSE
	return true
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
