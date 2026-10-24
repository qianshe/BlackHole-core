// Package brandicon renders the existing BlackHole Desktop/tray mark.
// Reuse exactly the same pixels for Windows executable resources so the
// taskbar, Start menu and native window cannot silently use a generic icon.
package brandicon

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"math"
)

// PNG returns the same blue event-horizon mark used by the desktop tray.
func PNG(size int) []byte {
	if size < 2 {
		panic("icon size must be at least 2")
	}
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	c := float64(size-1) / 2
	blue := color.NRGBA{0x25, 0x63, 0xeb, 0xff}
	core := color.NRGBA{0x0f, 0x11, 0x15, 0xff}
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			d := math.Hypot(float64(x)-c, float64(y)-c) / c
			switch {
			case d <= 0.45:
				img.Set(x, y, core)
			case d <= 1.0:
				img.Set(x, y, blue)
			}
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		panic(err)
	}
	return out.Bytes()
}
