//go:build windows

package main

import "testing"

func TestDarkCaptionAttributesPreserveStandardWindowChrome(t *testing.T) {
	const hwnd = uintptr(0x1234)
	type call struct {
		hwnd  uintptr
		id    uintptr
		value uint32
	}
	var calls []call
	applyCaptionAttributes(hwnd, func(gotHwnd, id uintptr, value uint32) {
		calls = append(calls, call{gotHwnd, id, value})
	})
	want := []call{
		{hwnd, 20, 1},          // DWM immersive dark mode
		{hwnd, 35, 0x00181818}, // caption background
		{hwnd, 36, 0x00F2F2F2}, // caption text
		{hwnd, 34, 0x00303031}, // native border
	}
	if len(calls) != len(want) {
		t.Fatalf("unexpected number of DWM attrs: got %d, want %d", len(calls), len(want))
	}
	for i, expected := range want {
		if calls[i] != expected {
			t.Errorf("attribute #%d = %#v; want %#v", i, calls[i], expected)
		}
	}
}

func TestDarkCaptionSkipsInvalidWindow(t *testing.T) {
	applyCaptionAttributes(0, func(uintptr, uintptr, uint32) {
		t.Fatal("invalid HWND must never be sent to DWM")
	})
}
