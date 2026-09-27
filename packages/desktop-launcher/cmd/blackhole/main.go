// Command blackhole is the desktop entry point: it starts or attaches to the
// local daemon and opens the signed-in local Web UI in the default browser.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"blackhole/desktop-launcher/internal/bootstrap"
	"blackhole/desktop-launcher/internal/daemonctl"
)

var messages = map[string]string{
	"instance_conflict":     "另一个 BlackHole 实例正在运行。",
	"port_conflict":         "BlackHole 端口已被其他程序占用。",
	"runtime_asset_missing": "BlackHole 运行文件缺失，请重新安装。",
	"kernel_exited":         "BlackHole 后台服务启动失败。",
	"ready_timeout":         "BlackHole 后台服务启动超时。",
	"browser_unavailable":   "无法打开浏览器。",
	"stop_rejected":         "BlackHole 拒绝了停止请求。",
	"stop_timeout":          "BlackHole 没有在规定时间内停止。",
	"protocol_incompatible": "BlackHole 后台服务版本不兼容。",
}

func describe(r bootstrap.Result) string {
	text := messages[r.Code]
	if text == "" {
		text = "BlackHole 启动失败。"
	}
	if r.Message != "" {
		text += "\n\n" + r.Message
	}
	if r.Receipt != nil && r.Code == "browser_unavailable" {
		text += "\n\n" + r.Receipt.LocalURL
	}
	if r.LogPath != "" {
		text += "\n\n日志：" + r.LogPath
	}
	return text
}

func main() {
	noBrowser := flag.Bool("no-browser", false, "start or attach to the daemon without opening the window")
	windowMode := flag.Bool("window", false, "internal: show the app window for the ticket URL read from stdin")
	stop := flag.Bool("stop", false, "stop the running daemon")
	trayOnly := flag.Bool("tray", false, "start in the background with the tray icon, without opening the window (used by autostart)")
	noTray := flag.Bool("no-tray", false, "exit after launching instead of staying in the tray")
	printResult := flag.Bool("print", false, "print the launch result as JSON instead of showing dialogs")
	flag.Parse()
	if *windowMode {
		os.Exit(runWindowMode())
	}
	// Scripted calls (--stop/--print) keep the plain bootstrap behavior.
	interactive := !*stop && !*printResult

	var result bootstrap.Result
	rt, err := bootstrap.Locate(bootstrap.DefaultEnv())
	if err != nil {
		code := "kernel_exited"
		if errors.Is(err, bootstrap.ErrAssetMissing) {
			code = "runtime_asset_missing"
		}
		result = bootstrap.Result{Code: code, Message: err.Error()}
	} else {
		var extra []string
		if *stop {
			extra = append(extra, "--stop")
		}
		if *noBrowser || *trayOnly || interactive {
			extra = append(extra, "--no-browser")
		}
		result = bootstrap.Run(context.Background(), rt, extra, 60*time.Second)
	}

	if *printResult {
		out, _ := json.Marshal(result)
		fmt.Println(string(out))
	} else if !result.OK {
		showError("BlackHole", describe(result))
	}
	if !result.OK {
		os.Exit(1)
	}
	// Stay resident in the tray (one tray per daemon port) unless this was a
	// scripted call. The tray's heartbeat keeps the channel open while it runs.
	if !interactive || result.Receipt == nil {
		return
	}
	port, ok := daemonctl.PortFromURL(result.Receipt.LocalURL)
	if !ok {
		return
	}
	if !*noBrowser && !*trayOnly {
		openUI(context.Background(), rt, port)
	}
	if !*noTray && acquireTray(port) {
		runTray(rt, port)
	}
}
