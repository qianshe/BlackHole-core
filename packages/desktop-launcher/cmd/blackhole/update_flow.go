package main

import (
	"context"
	"errors"
	"sync/atomic"

	"blackhole/desktop-launcher/internal/distribution"
	"blackhole/desktop-launcher/internal/updatefeed"
)

var checkingUpdate atomic.Bool

// Page-driven update flow, started from the settings card's download button.
// The click is the authorization: no confirmation dialogs on the happy path.
// Every guard stays — signed feed verification, publisher re-confirmation,
// staged-file re-verification and the Manager's refusal to stop a Core with
// active clients or work. Errors surface natively and in the card status.
func runDesktopUpdate(stopForUpdate func(context.Context) bool, finished func()) {
	if !checkingUpdate.CompareAndSwap(false, true) {
		showInfo("BlackHole", "已有更新流程正在进行。")
		return
	}
	defer checkingUpdate.Store(false)
	bundle, err := distribution.Locate()
	if err != nil {
		showError("BlackHole", "无法定位本机 BlackHole 安装；未下载或安装任何内容。")
		return
	}
	feed, checker, root, err := nativeChecker(bundle)
	if err != nil {
		showInfo("BlackHole", "此构建的更新发布通道尚不可用；不会下载或安装未经验证的包。")
		return
	}
	status, ran := checker.Check(context.Background(), true)
	if !ran {
		showInfo("BlackHole", "已有版本检查正在进行，请稍后重试。")
		return
	}
	if status.State == "error" {
		showError("BlackHole", "检查更新失败，当前应用可继续使用。")
		return
	}
	release := checker.VerifiedRelease()
	if release == nil {
		showInfo("BlackHole", "当前已经是最新发布版本。")
		return
	}
	ctx := context.Background()
	stage := feed.FindStagedRelease(root, *release)
	if stage == "" {
		transfer := nativeTransfer(root, bundle.Version)
		stage, err = transfer.Run(ctx, *release, func(sub context.Context, notify func(updatefeed.DownloadProgress)) (string, error) {
			return feed.StageWithProgress(sub, *release, root, notify)
		})
		if err != nil {
			if errors.Is(err, context.Canceled) {
				showInfo("BlackHole", "更新下载已取消，当前版本和任务继续运行。")
			} else {
				// HTTP errors can contain GitHub's short-lived signed CDN URL.
				showError("BlackHole", "更新下载或完整性验证失败，未安装更新、未停止 Core。请检查网络后重试。")
			}
			return
		}
	}
	// A saved/fully downloaded file does not authorize installation after the
	// publisher withdraws it. Recheck before closing any window or stopping Core.
	if err := feed.ConfirmRelease(ctx, *release); err != nil {
		showError("BlackHole", "无法再次确认此版本仍可安装（发布可能已更新或撤回，或网络不可用）。当前应用继续运行，请重新检查更新。")
		return
	}
	if verified, _, err := feed.VerifyStage(stage); err != nil || verified != release.Manifest {
		showError("BlackHole", "已下载文件发生变化或验证失败，未停止 Core，也未启动安装器。")
		return
	}
	// The native maintenance coordinator closes our peer window and asks the
	// Manager to stop the exact Core target. An active task/client or an
	// ambiguous result prevents any installer launch.
	if stopForUpdate == nil || !stopForUpdate(ctx) {
		return
	}
	if err := handoffUpdate(stage); err != nil {
		showError("BlackHole", "Core 已正常停止，但更新助手未能启动，未安装更新。请从开始菜单重新打开 BlackHole；不要强制重复安装。错误："+err.Error())
		if finished != nil {
			finished()
		}
		return
	}
	// This UI process detaches its own lease and exits; the helper waits for
	// exactly that exit before running the verified installer.
	if finished != nil {
		finished()
	}
}
