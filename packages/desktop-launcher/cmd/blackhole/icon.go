package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
)

// trayPNG draws the tray icon: a blue ring around a dark core.
func trayPNG(size int) []byte {
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
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	return b.Bytes()
}

// pngToICO wraps one PNG in an ICO container (Windows Vista+ reads PNG entries).
func pngToICO(p []byte, size int) []byte {
	var b bytes.Buffer
	w := func(v any) { _ = binary.Write(&b, binary.LittleEndian, v) }
	w(uint16(0))
	w(uint16(1))
	w(uint16(1))
	dim := uint8(size)
	if size >= 256 {
		dim = 0
	}
	b.Write([]byte{dim, dim, 0, 0})
	w(uint16(1))
	w(uint16(32))
	w(uint32(len(p)))
	w(uint32(6 + 16))
	b.Write(p)
	return b.Bytes()
}
