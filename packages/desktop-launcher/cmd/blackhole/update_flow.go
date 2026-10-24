package main

import (
	"context"
	"errors"
	"fmt"

	"blackhole/desktop-launcher/internal/updatefeed"
	"sync/atomic"

	"fyne.io/systray"

	"blackhole/desktop-launcher/internal/distribution"
)

var checkingUpdate atomic.Bool

// Native tray only: an untrusted Web page never receives a URL, file path,
// process identifier, or a way to launch an installer.
func checkAndOfferUpdate(ctx context.Context, bundle distribution.Bundle, stopForUpdate func(context.Context) bool) {
	if !checkingUpdate.CompareAndSwap(false, true) {
		showInfo("BlackHole", "已有更新检查正在进行。")
		return
	}
	defer checkingUpdate.Store(false)
	feed, checker, root, err := nativeChecker(bundle)
	if err != nil {
		showInfo("BlackHole", "此构建的更新发布通道尚不可用；不会下载或安装未经验证的包。")
		return
	}
	status, ran := checker.Check(ctx, true)
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
	stage := feed.FindStagedRelease(root, *release)
	if stage == "" {
		if !showConfirm("BlackHole 更新", fmt.Sprintf("发现新版本 %s。\n\n现在下载完整安装包？下载期间可以继续使用 BlackHole。", release.Manifest.Label())) {
			return
		}
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
	if !showConfirm("BlackHole 更新",
		fmt.Sprintf("版本 %s 已完整下载并通过签名/哈希验证。\n\n立即更新将正常关闭本机 Desktop 窗口和托盘，然后运行安装器。\nShared Core 只有在无活动 Agent 任务、无其他客户端阻止时才会切换；不会强制停止工作。\n\n现在开始安装？", release.Manifest.Label())) {
		showInfo("BlackHole", "更新已下载，当前版本继续运行。可稍后再次检查更新。")
		return
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
	// The same native maintenance coordinator closes our peer window, confirms
	// the exact Core target and asks Manager to stop it. An active task/client
	// or ambiguous result prevents any installer launch.
	if stopForUpdate == nil || !stopForUpdate(ctx) {
		return
	}
	if err := handoffUpdate(stage); err != nil {
		showError("BlackHole", "Core 已正常停止，但更新助手未能启动，未安装更新。请从开始菜单重新打开 BlackHole；不要强制重复安装。错误："+err.Error())
		systray.Quit()
		return
	}
	// Parent exits, detaching its own lease. Helper waits for that exact
	// process to exit; Inno AppMutex ensures other native shells are closed.
	systray.Quit()
}
