package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	"blackhole/desktop-launcher/internal/updatefeed"
	"fyne.io/systray"
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
func downloadInProgress(s updatefeed.DownloadStatus) bool {
	return s.State == "downloading" || s.State == "verifying" || s.State == "cancelling"
}
func downloadMenuTitle(s updatefeed.DownloadStatus) string {
	switch s.State {
	case "downloading":
		if s.TotalBytes > 0 {
			return fmt.Sprintf("正在下载更新 %.0f%%…", float64(s.Bytes)*100/float64(s.TotalBytes))
		}
		return "正在下载更新…"
	case "verifying":
		return "正在验证更新文件…"
	case "cancelling":
		return "正在取消更新下载…"
	case "ready":
		return "更新已下载，点击重新检查并安装…"
	case "cancelled":
		return "更新下载已取消，点击重试…"
	case "error":
		return "更新下载失败，点击重试…"
	default:
		return ""
	}
}
func watchUpdateTransfer(ctx context.Context, root, current string, checker *updatefeed.Checker, item *systray.MenuItem) {
	transfer := nativeTransfer(root, current)
	cancelItem := systray.AddMenuItem("取消更新下载", "只取消下载，不停止 Core 或删除会话")
	cancelItem.Disable()
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-cancelItem.ClickedCh:
				transfer.Cancel()
			case <-ticker.C:
				s := transfer.Status()
				if downloadInProgress(s) {
					cancelItem.Enable()
				} else {
					cancelItem.Disable()
				}
				label := downloadMenuTitle(s)
				// Do not advertise an older downloaded package after the latest check has
				// failed or after Cloud has replaced/withdrawn that release.
				c := checker.Status()
				if s.State == "ready" && (c.State != "available" || s.Version != c.AvailableVersion) {
					label = ""
				}
				if label == "" {
					label = updateMenuTitle(c)
				}
				item.SetTitle(label)
			}
		}
	}()
}
