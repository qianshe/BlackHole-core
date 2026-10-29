package main

import (
	"bytes"
	"encoding/binary"

	"blackhole/desktop-launcher/internal/brandicon"
)

// The tray, native window and executable icon use one shared BlackHole mark.
func trayPNG(size int) []byte { return brandicon.PNG(size) }

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
