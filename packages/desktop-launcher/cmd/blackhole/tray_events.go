package main

import "context"

// watchTrayActions has no daemon lifecycle authority. Quit always closes only
// the tray, regardless of other clients or daemon reachability. Once Manager
// leases are wired, local teardown may detach this instance, never stop Core.
func watchTrayActions(ctx context.Context, open, auto, quit <-chan struct{}, onOpen, onAuto, onQuit func()) {
	for {
		if ctx.Err() != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-quit:
			onQuit()
			return
		case <-open:
			onOpen()
		case <-auto:
			onAuto()
		}
	}
}
