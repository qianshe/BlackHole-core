// Command icon-resource generates multi-resolution images from the exact
// BlackHole tray mark. The packaging step embeds these as Windows PE resources.
package main

import (
	"blackhole/desktop-launcher/internal/brandicon"
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: icon-resource OUTPUT_DIRECTORY")
		os.Exit(2)
	}
	dir := os.Args[1]
	if err := os.MkdirAll(dir, 0755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, size := range []int{16, 24, 32, 48, 64, 128, 256} {
		name := filepath.Join(dir, fmt.Sprintf("icon-%d.png", size))
		if err := os.WriteFile(name, brandicon.PNG(size), 0644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
}
