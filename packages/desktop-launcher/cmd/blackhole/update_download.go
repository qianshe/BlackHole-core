package main

import (
	"sync"

	"blackhole/desktop-launcher/internal/updatefeed"
)

var downloadTransfers struct {
	sync.Mutex
	key      string
	transfer *updatefeed.Transfer
}

func nativeTransfer(root, current string) *updatefeed.Transfer {
	downloadTransfers.Lock()
	defer downloadTransfers.Unlock()
	key := root + "\x00" + current
	if downloadTransfers.transfer == nil || downloadTransfers.key != key {
		downloadTransfers.key = key
		downloadTransfers.transfer = updatefeed.NewTransfer(root, current)
	}
	return downloadTransfers.transfer
}
