package brandicon

import (
	"bytes"
	"image/color"
	"image/png"
	"testing"
)

func TestWindowsTaskbarIconSizesAndColors(t *testing.T) {
	for _, size := range []int{16, 24, 32, 48, 64, 128, 256} {
		payload := PNG(size)
		decoded, err := png.Decode(bytes.NewReader(payload))
		if err != nil {
			t.Fatalf("size %d: %v", size, err)
		}
		bounds := decoded.Bounds()
		if bounds.Dx() != size || bounds.Dy() != size {
			t.Fatalf("size %d: dimensions = %v", size, bounds)
		}
		// The mark is an event-horizon blue ring, dark core and transparent
		// corners; the resource generator must not regress to Windows' generic glyph.
		n := decoded.(interface{ NRGBAAt(int, int) color.NRGBA })
		corner := n.NRGBAAt(0, 0)
		center := n.NRGBAAt(size/2, size/2)
		rim := n.NRGBAAt(size/2, 1)
		if corner.A != 0 || center != (color.NRGBA{R: 0x0f, G: 0x11, B: 0x15, A: 0xff}) {
			t.Fatalf("size %d: corner=%v center=%v", size, corner, center)
		}
		if size >= 24 && rim.A != 0xff {
			t.Fatalf("size %d: blue horizon disappeared: %v", size, rim)
		}
	}
}
