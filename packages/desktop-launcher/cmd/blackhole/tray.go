package main

import (
	"context"
	"time"

	"fyne.io/systray"

	"blackhole/desktop-launcher/internal/bootstrap"
	"blackhole/desktop-launcher/internal/daemonctl"
)

// runTray blocks until the user quits from the menu or the daemon goes away.
func runTray(rt bootstrap.Runtime, port int) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	systray.Run(func() { onReady(ctx, rt, port) }, cancel)
}

func onReady(ctx context.Context, rt bootstrap.Runtime, port int) {
	systray.SetIcon(platformIcon())
	systray.SetTooltip("BlackHole")
	open := systray.AddMenuItem("打开 BlackHole", "打开 BlackHole 窗口")
	systray.AddSeparator()
	auto := systray.AddMenuItemCheckbox("开机时启动", "登录系统后在后台启动 BlackHole", autostartEnabled())
	systray.AddSeparator()
	quit := systray.AddMenuItem("退出 BlackHole 托盘", "仅关闭桌面托盘，后台服务继续运行")

	go daemonctl.Client{Port: port}.Watch(ctx, 10*time.Second, 3, systray.Quit)

	go watchTrayActions(ctx, open.ClickedCh, auto.ClickedCh, quit.ClickedCh,
		func() { go openUI(ctx, rt, port) },
		func() {
			want := !auto.Checked()
			if err := setAutostart(want); err != nil {
				showError("BlackHole", "无法修改开机启动设置。\n\n"+err.Error())
				return
			}
			if want {
				auto.Check()
			} else {
				auto.Uncheck()
			}
		},
		systray.Quit,
	)
}
