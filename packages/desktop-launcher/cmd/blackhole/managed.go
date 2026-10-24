package main

import (
	"blackhole/desktop-launcher/internal/coremanager"
	"blackhole/desktop-launcher/internal/daemonctl"
	"blackhole/desktop-launcher/internal/distribution"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"fyne.io/systray"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

var legacyMode bool
var managedStateDir string
var managedUserDataDir string
var sharedTrayInstanceID string

func configureManagedUI(bundle distribution.Bundle, port int) {
	managedUserDataDir = filepath.Dir(bundle.Client.Store)
	managedStateDir = filepath.Join(managedUserDataDir, "runtime-state", "desktop", strconv.Itoa(port))
	windowTitle = "BlackHole · " + strconv.Itoa(port)
}

func main() {
	// Detached copy runs outside the install directory. It waits for the old
	// Desktop process to exit before launching an independently verified setup.
	if len(os.Args) > 1 && os.Args[1] == "--update-helper" {
		os.Exit(runUpdateHelper(os.Args[2:]))
	}
	for i, arg := range os.Args[1:] {
		if arg == "--legacy-dev" {
			if !allowLegacy {
				fmt.Fprintln(os.Stderr, "legacy_runtime_disabled")
				os.Exit(1)
			}
			os.Args = append(os.Args[:i+1], os.Args[i+2:]...)
			legacyMode = true
			legacyMain()
			return
		}
	}
	os.Exit(managedMain(os.Args[1:]))
}
func instanceID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func desktopHost(b distribution.Bundle) coremanager.Host {
	return coremanager.Host{ClientID: "desktop:" + b.Environment, InstanceID: instanceID(), Kind: "desktop", Version: b.Version, Protocol: coremanager.Protocol{Min: 1, Max: 1}, Capabilities: []string{"web-ui"}}
}
func managedMain(args []string) int {
	flags := flag.NewFlagSet("blackhole", flag.ContinueOnError)
	printResult := flags.Bool("print", false, "print a bounded result without opening UI")
	noBrowser := flags.Bool("no-browser", false, "do not open a window")
	noTray := flags.Bool("no-tray", false, "exit after startup")
	trayOnly := flags.Bool("tray", false, "start the tray without a window")
	window := flags.Bool("window", false, "internal: ticket URL over stdin")
	stop := flags.Bool("stop", false, "explicit Manager-protected stop")
	restart := flags.Bool("restart", false, "restart the pinned running Core")
	maintenanceConfirm := flags.Bool("confirm-maintenance", false, "confirm the selected maintenance operation")
	inspectMaintenance := flags.Bool("inspect-maintenance", false, "inspect pending maintenance transactions without mutation")
	recoverMaintenance := flags.String("recover-maintenance", "", "recover a positively dead maintenance target by transaction ID")
	acceptCurrent := flags.String("accept-current", "", "explicitly acknowledge this verified replacement fingerprint; requires --recover-maintenance")
	settingsRevision := flags.Int("apply-settings", -1, "expected saved settings revision; requires --restart")
	configurePort := flags.Int("configure-port", 0, "save a port only after Core has been explicitly stopped")
	provision := flags.Bool("provision-only", false, "verify/provision Core without starting daemon")
	applyBundled := flags.Bool("apply-bundled-core", false, "installer: verify and apply bundled Core using the guarded Manager upgrade")
	repair := flags.Bool("repair-start", false, "inspect an unresolved start")
	confirm := flags.Bool("confirm-repair", false, "confirm recovery of a proven dead instance")
	forceRepair := flags.Bool("force-repair", false, "with --repair --confirm-repair, also accept a record whose port is closed and whose leases expired")
	portArg := flags.Int("port", 0, "configured loopback port")
	if flags.Parse(args) != nil {
		return 2
	}
	if *window {
		release, err := holdInstallMutex()
		if err != nil {
			return 1
		}
		defer release()
		return runWindowMode()
	}
	fail := func(err error) int {
		if *printResult {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": false, "code": "managed_launch_failed", "message": err.Error()})
		} else {
			showError("BlackHole", err.Error())
		}
		return 1
	}
	if *confirm && !*repair {
		return fail(errors.New("repair_flag_required"))
	}
	operations := 0
	for _, selected := range []bool{*stop, *restart, *inspectMaintenance, *recoverMaintenance != "", *configurePort != 0, *repair, *provision, *applyBundled} {
		if selected {
			operations++
		}
	}
	if (*acceptCurrent != "" && *recoverMaintenance == "") || operations > 1 || (*settingsRevision >= 0 && !*restart) || *settingsRevision < -1 {
		return fail(errors.New("maintenance_flags_conflict"))
	}
	mutation := *stop || *restart || *recoverMaintenance != "" || *configurePort != 0
	if mutation && !*maintenanceConfirm {
		return fail(errors.New("maintenance_confirmation_required"))
	}
	if *maintenanceConfirm && !mutation {
		return fail(errors.New("maintenance_operation_required"))
	}
	// Own the install mutex during the *entire* interactive native startup,
	// not only after the Manager attach: otherwise Setup could replace the
	// executable while the tray was starting. Headless installer/Manager
	// maintenance commands deliberately do not hold this shell-only mutex.
	if !*printResult && operations == 0 {
		release, err := holdInstallMutex()
		if err != nil {
			return fail(err)
		}
		defer release()
	}
	bundle, err := distribution.Locate()
	if err != nil {
		return fail(err)
	}
	// Release channel does not create a second local service. Explicit ports
	// remain available for isolated tests; Manager's saved endpoint wins next.
	port, err := configuredManagedPort(os.Getenv("BLACKHOLE_PORT"), *portArg)
	if err != nil {
		return fail(err)
	}
	ctx := context.Background()
	if *inspectMaintenance {
		records, err := bundle.Client.InspectMaintenances(ctx)
		if err != nil {
			return fail(err)
		}
		current, err := bundle.Client.InspectStart(ctx)
		if err != nil {
			return fail(err)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "transactions": records, "current": current})
		return 0
	}
	if *recoverMaintenance != "" {
		if err := bundle.Client.ReconcileMaintenance(ctx, *recoverMaintenance, *acceptCurrent, true); err != nil {
			return fail(err)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "recovered": true, "restarted": false})
		return 0
	}
	endpoint, err := bundle.Client.ResolveEndpoint(ctx, port)
	if err != nil {
		return fail(err)
	}
	port = endpoint.Port
	if *configurePort != 0 {
		saved, err := bundle.Client.ConfigureEndpoint(ctx, endpoint, *configurePort, true)
		if err != nil {
			return fail(err)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "endpoint": saved, "started": false})
		return 0
	}
	if *repair {
		state, err := bundle.Client.InspectStart(ctx)
		if err != nil {
			return fail(err)
		}
		if state != nil && *confirm {
			if err = bundle.Client.RecoverStart(ctx, *state, true, *forceRepair); err != nil {
				return fail(err)
			}
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "recovered": state != nil && *confirm, "confirmationRequired": state != nil && !*confirm, "state": state})
		return 0
	}
	host := desktopHost(bundle)
	if *applyBundled {
		result, err := applyBundledCore(ctx, bundle.Client, bundle, host, port)
		if err != nil {
			return fail(err)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "result": result})
		return 0
	}
	if *stop || *restart {
		record, err := bundle.Client.InspectStart(ctx)
		if err != nil {
			return fail(err)
		}
		if record == nil || record.Status != "ready" || record.Receipt == nil || record.Port != port {
			return fail(errors.New("managed_running_core_required"))
		}
		attached, err := bundle.Client.AttachExisting(ctx, host, port, record.StartFingerprint)
		if err != nil {
			return fail(err)
		}
		defer func() { _ = bundle.Client.Detach(context.Background(), attached.Lease.Handle()) }()
		if attached.Receipt.DataRootID != endpoint.DataRootID || attached.Receipt.DaemonID != record.Receipt.DaemonID || attached.Receipt.StartFingerprint != record.StartFingerprint {
			return fail(errors.New("maintenance_target_changed"))
		}
		operation := "stop"
		if *restart {
			operation = "restart"
		}
		var revision *int
		if *settingsRevision >= 0 {
			revision = settingsRevision
		}
		requestID := instanceID()
		result, err := bundle.Client.Maintain(ctx, host, attached, port, operation, requestID, true, revision)
		if err != nil {
			return fail(fmt.Errorf("maintenance_request_%s: %w", requestID, err))
		}
		if result.Attachment != nil {
			defer func() { _ = bundle.Client.Detach(context.Background(), result.Attachment.Lease.Handle()) }()
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "result": result})
		return 0
	}
	if *provision {
		if err = bundle.Client.Ensure(ctx, host, port, bundle.Seed, bundle.SeedHash); err != nil {
			return fail(err)
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "provisioned": true})
		return 0
	}
	configureManagedUI(bundle, port)
	hasTray := !*printResult && !*noTray && acquireTray(port)
	if !hasTray && !*printResult && !*noTray {
		// Another Desktop process already owns the tray for this port.
		// Focus an open window or spawn a window sharing the tray's lease
		// without creating a second Desktop lease.
		if !*noBrowser && !*trayOnly {
			if focusExistingWindow() {
				return 0
			}
			if _, trayID, live := (peerReleaseStore{dir: managedStateDir}).presenceInstance(); live && len(trayID) == 36 {
				sharedTrayInstanceID = trayID
				if url, err := (daemonctl.Client{Port: port}).WelcomeURL(); err == nil && spawnWindow(url) != exitNoWebView {
					return 0
				}
			}
		} else {
			return 0
		}
	}
	// Same signed, bundle-first bootstrap as VS Code: update before exposing
	// normal business UI. No second user confirmation or alternate daemon.
	startup, err := bundle.Client.StartBundled(ctx, host, port, bundle.Seed, bundle.SeedHash, instanceID())
	if err != nil {
		return fail(err)
	}
	attached := startup.Attachment
	if startup.State == "rolled_back" {
		fmt.Fprintln(os.Stderr, "Core update rolled back; the previous verified runtime remains active.")
	}
	if attached.Receipt.DataRootID != endpoint.DataRootID {
		_ = bundle.Client.Detach(ctx, attached.Lease.Handle())
		return fail(errors.New("managed_data_root_mismatch"))
	}
	if hasTray {
		sharedTrayInstanceID = host.InstanceID
		(peerReleaseStore{dir: managedStateDir}).announcePresenceWithInstance(attached.Receipt.StartFingerprint, host.InstanceID)
	} else if !*printResult && !*noTray {
		if _, trayID, live := (peerReleaseStore{dir: managedStateDir}).presenceInstance(); live && len(trayID) == 36 {
			sharedTrayInstanceID = trayID
		}
	}
	leaseCtx, keeperCancel := context.WithCancel(context.Background())
	keeper := newLeaseKeeper(bundle.Client, host, attached, port, keeperCancel)
	keeper.useBundle(startup, nil)
	keeper.start()
	defer keeper.release()
	desktopLog(fmt.Sprintf("desktop attached: port=%d version=%s build=%s instance=%s tray=%v",
		port, attached.Receipt.DaemonVersion, attached.Receipt.BuildID, host.InstanceID, hasTray))
	if *printResult {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ok": true, "receipt": attached.Receipt, "browserOpened": false})
		return 0
	}
	if !*noBrowser && !*trayOnly {
		openManagedUI(leaseCtx, bundle.Client, attached, port)
	}
	if hasTray {
		runManagedTray(leaseCtx, bundle, keeper, port)
	}
	return 0
}

// acquireWindowLease attaches the window process and installs the native
// maintenance coordinator behind the WebView bridge. When launched under a
// tray owner, the window shares the tray's clientInstanceId/lease so Desktop
// holds a single lease that is released when the tray exits.
func acquireWindowLease(url string) (func(), error) {
	port, ok := daemonctl.PortFromURL(url)
	if !ok {
		return nil, errors.New("invalid_window_origin")
	}
	bundle, err := distribution.Locate()
	if err != nil {
		return nil, err
	}
	configureManagedUI(bundle, port)
	store := peerReleaseStore{dir: managedStateDir}
	host := desktopHost(bundle)
	trayOwned := false
	trayID := os.Getenv("BLACKHOLE_DESKTOP_TRAY_INSTANCE_ID")
	if len(trayID) != 36 {
		if _, pID, live := store.presenceInstance(); live && len(pID) == 36 {
			trayID = pID
		}
	}
	if len(trayID) == 36 {
		host.InstanceID = trayID
		trayOwned = true
	}
	startup, err := bundle.Client.StartBundled(context.Background(), host, port, bundle.Seed, bundle.SeedHash, instanceID())
	if err != nil {
		return nil, err
	}
	attached := startup.Attachment
	keeper := newLeaseKeeper(bundle.Client, host, attached, port, nil)
	keeper.useBundle(startup, func(next coremanager.Attachment) {
		if reloadManagedWindow != nil {
			if target, e := (daemonctl.Client{Port: port}).WelcomeURL(); e == nil {
				reloadManagedWindow(target)
			}
		}
	})
	if !trayOwned {
		keeper.start()
	}
	coordinator := newMaintenanceCoordinator(bundle.Client, keeper, nativePromptsImpl{}, maintenanceHooks{
		PreparePeers: func(ctx context.Context, fingerprint string) error {
			if trayOwned {
				return nil
			}
			// Only a live tray presence for this incarnation can block us;
			// anything else is decided authoritatively by the Manager.
			if fp, live := store.presence(); !live || fp != fingerprint {
				return nil
			}
			return store.request(ctx, fingerprint, 10*time.Second)
		},
		OnStopped: func() {
			if trayOwned {
				store.publishStop(keeper.current().Receipt.StartFingerprint)
			}
			closeManagedWindow()
		},
		OnRestarted: func(next coremanager.Attachment) {
			if trayOwned {
				store.publishAttachment(next)
			}
			if reloadManagedWindow == nil {
				return
			}
			url, err := daemonctl.Client{Port: port}.WelcomeURL()
			if err == nil {
				reloadManagedWindow(url)
			}
			_ = next
		},
		OnReleasedForRecovery: func() { closeManagedWindow() },
	})
	windowCoordinator = coordinator
	syncSharedKeeper := func() {
		if !trayOwned {
			return
		}
		if next, ok := store.consumeAttachment(); ok {
			_ = keeper.adopt(next)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if state, err := bundle.Client.InspectStart(ctx); err == nil && state != nil && state.Status == "ready" && state.Receipt != nil && state.StartFingerprint != keeper.current().Receipt.StartFingerprint {
			if latest, err := bundle.Client.AttachExisting(ctx, host, port, state.StartFingerprint); err == nil {
				_ = keeper.adopt(latest)
			}
		}
	}
	desktopWelcomeActionHandler = func(action string) (string, error) {
		// Verification includes Manager validation and a bounded cloud read.
		// The native deadline must cover both, rather than timing out at 5s.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if action != "status" {
			syncSharedKeeper()
			// The Manager must still recognize this window's lease and Core
			// incarnation before any state-changing native account action.
			if _, err := bundle.Client.Heartbeat(ctx, keeper.current().Lease.Handle(), port); err != nil {
				return "", err
			}
		}
		account := daemonctl.Client{Port: port}
		var status daemonctl.WelcomeStatus
		var err error
		if action == "status" {
			status, err = account.Welcome(ctx)
		} else {
			status, err = account.LoginAction(ctx, action)
		}
		if err != nil {
			return "", err
		}
		b, err := json.Marshal(status)
		return string(b), err
	}
	desktopCoreActionHandler = func(action string, revision *int) (bool, error) {
		syncSharedKeeper()
		switch action {
		case "apply-settings":
			if revision == nil {
				return false, errors.New("invalid_settings_revision")
			}
			return coordinator.Run(context.Background(), "restart", revision), nil
		case "restart":
			return coordinator.Run(context.Background(), "restart", nil), nil
		case "stop":
			return coordinator.Run(context.Background(), "stop", nil), nil
		case "inspect-maintenance":
			return coordinator.RunInspect(context.Background()), nil
		case "configure-port":
			// Cold port changes need a stopped Core and no live leases, so a
			// running Web window can never complete one. Keep the CLI/VSIX
			// native path instead of pretending this click changed the port.
			showInfo("BlackHole", "共享端口只能在 Core 停止且无活跃租约后冷变更。请先停止 Core，再运行 Desktop CLI：BlackHole.exe --configure-port <端口> --confirm-maintenance --print")
			return false, nil
		}
		return false, errors.New("invalid_core_action")
	}
	if trayOwned {
		return func() {}, nil
	}
	return keeper.release, nil
}

// windowCoordinator and desktopCoreActionHandler are installed by the window
// process before its WebView is created. They stay nil in the tray process
// and in legacy mode, where no Desktop Web bridge exists.
var windowCoordinator *maintenanceCoordinator
var desktopCoreActionHandler func(action string, revision *int) (bool, error)
var desktopWelcomeActionHandler func(action string) (string, error)
var reloadManagedWindow func(url string)

func openManagedUI(ctx context.Context, client coremanager.Client, attached coremanager.Attachment, port int) {
	if focusExistingWindow() {
		return
	}
	if _, err := client.Heartbeat(ctx, attached.Lease.Handle(), port); err != nil {
		showError("BlackHole", err.Error())
		return
	}
	url, err := daemonctl.Client{Port: port}.WelcomeURL()
	if err != nil {
		showError("BlackHole", err.Error())
		return
	}
	if spawnWindow(url) == exitNoWebView {
		if err = client.OpenBrowser(ctx, attached.Lease.Handle(), port); err != nil {
			showError("BlackHole", err.Error())
		}
	}
}
func runManagedTray(ctx context.Context, bundle distribution.Bundle, keeper *leaseKeeper, port int) {
	defer closeManagedWindow()
	store := peerReleaseStore{dir: managedStateDir}
	// Announce this tray and answer window-initiated lease-release requests.
	// Releasing here detaches only the tray's own lease and exits the tray;
	// the initiating window and the Manager keep full authority.
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		defer store.clearPresence()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			if next, ok := store.consumeAttachment(); ok {
				_ = keeper.adopt(next)
			}
			if store.consumeStop(keeper.current().Receipt.StartFingerprint) {
				keeper.markConsumed()
				desktopLog("tray quit: stop published by window")
				systray.Quit()
				return
			}
			store.announcePresenceWithInstance(keeper.current().Receipt.StartFingerprint, keeper.host.InstanceID)
			req, _ := store.pending()
			if req != nil && req.Fingerprint == keeper.current().Receipt.StartFingerprint {
				_ = store.acknowledge(*req)
				keeper.release()
				desktopLog("tray quit: lease release requested by window")
				systray.Quit()
				return
			}
		}
	}()
	systray.Run(func() {
		systray.SetIcon(platformIcon())
		systray.SetTooltip("BlackHole")
		open := systray.AddMenuItem("打开 BlackHole", "打开共享 Core 的 Web 窗口")
		// Updates and Core maintenance live in the settings page; the tray
		// keeps daily-driver actions only. The version check runs silently.
		startBackgroundUpdateChecks(ctx, bundle)
		var auto *systray.MenuItem
		var autoCh <-chan struct{}
		if bundle.Environment == "production" {
			systray.AddSeparator()
			auto = systray.AddMenuItemCheckbox("开机时启动", "登录后启动此桌面应用", autostartEnabled())
			autoCh = auto.ClickedCh
		}
		systray.AddSeparator()
		quit := systray.AddMenuItem("退出 BlackHole 托盘", "仅解绑桌面客户端，后台服务继续运行")
		go daemonctl.Client{Port: port}.Watch(ctx, 10*time.Second, 3, func() {
			desktopLog("tray quit: daemon gone (3 consecutive missed beats)")
			systray.Quit()
		})
		go func() { <-ctx.Done(); desktopLog("tray quit: lease context done"); systray.Quit() }()
		go watchManagedTrayActions(ctx, trayActionChannels{open: open.ClickedCh, auto: autoCh, quit: quit.ClickedCh}, trayActionHandlers{
			onOpen:   func() { go openManagedUI(ctx, bundle.Client, keeper.current(), port) },
			onAuto: func() {
				if auto == nil {
					return
				}
				want := !auto.Checked()
				if err := setAutostart(want); err != nil {
					showError("BlackHole", err.Error())
					return
				}
				if want {
					auto.Check()
				} else {
					auto.Uncheck()
				}
			},
			onQuit: systray.Quit,
		})
	}, func() {})
}

type trayActionChannels struct {
	open, auto, quit <-chan struct{}
}

type trayActionHandlers struct {
	onOpen, onAuto, onQuit func()
}

// watchManagedTrayActions dispatches managed-tray clicks. Quit stays local
// and terminal, exactly like the legacy tray.
func watchManagedTrayActions(ctx context.Context, channels trayActionChannels, handlers trayActionHandlers) {
	for {
		if ctx.Err() != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-channels.quit:
			handlers.onQuit()
			return
		case <-channels.open:
			handlers.onOpen()
		case <-channels.auto:
			handlers.onAuto()
		}
	}
}
