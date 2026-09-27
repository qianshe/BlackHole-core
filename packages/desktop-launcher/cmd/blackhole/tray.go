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
	quit := systray.AddMenuItem("退出 BlackHole", "停止后台服务并退出")

	go daemonctl.Client{Port: port}.Watch(ctx, 10*time.Second, 3, systray.Quit)

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-open.ClickedCh:
				go openUI(ctx, rt, port)
			case <-auto.ClickedCh:
				want := !auto.Checked()
				if err := setAutostart(want); err != nil {
					showError("BlackHole", "无法修改开机启动设置。\n\n"+err.Error())
					continue
				}
				if want {
					auto.Check()
				} else {
					auto.Uncheck()
				}
			case <-quit.ClickedCh:
				quit.Disable()
				// VS Code still uses the daemon: close only the tray, keep the service.
				if (daemonctl.Client{Port: port}).OthersActive(ctx) {
					systray.Quit()
					return
				}
				r := bootstrap.Run(ctx, rt, []string{"--stop"}, 30*time.Second)
				if r.OK {
					systray.Quit()
					return
				}
				showError("BlackHole", describe(r))
				quit.Enable()
			}
		}
	}()
}
