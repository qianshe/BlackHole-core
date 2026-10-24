# Desktop launcher — Shared Core development candidate

The default Windows x64 `blackhole.exe` now uses **compiler-pinned bootstrap →
Manager → verified shared Core**. It preserves the native WebView/tray shell;
it is not a second business UI. The installer and interactive acceptance gates
below are still open: this is **not a production release**.

## Runtime boundary

- `internal/distribution` verifies app-neighbor Node, Manager and public trust
  files against hashes compiled into the executable. No PATH/CWD/runtime-dir or
  mutable manifest fallback is accepted. All installed hosts use
  `HOME/.blackhole/core`; noncanonical `BH_CORE_STORE`/data-root overrides are
  rejected, not ignored or used as another profile. Production still rejects
  a pinned test trust configuration.
- Manager selects the verified recorded running Core first, then active, then
  known-good only when active is absent. Corrupt selected state fails closed.
  A compatible existing Core wins even if the packaged Seed is missing/broken.
- Only when no usable selection exists does Manager verify the pinned offline
  Seed, stage it transactionally and activate it under the install/lifecycle
  locks. It rechecks selection before activation; it never downgrades a Core
  selected by another client. Legacy listeners require migration, not fallback.
- New v2 packages distribute one Node plus its pinned license outside the
  node-free Core ZIP. Distribution prepares a verified content-addressed Node
  under `~/.blackhole/core/runtimes/`; Manager, daemon and cleanup use that
  stable executable, so shell replacement does not hold the active runtime.
  The installation copy and stable cache may coexist on disk; only one copy is
  transferred in the package. Old v1 signed layouts remain readable.
- Tray and native windows have independent Manager leases. A window ticket is
  passed through stdin only. Browser fallback obtains a fresh ticket through
  Manager and opens a temporary file; ticket-bearing URLs never enter argv.
- Window coordination is port-scoped under `HOME/.blackhole/runtime-state/desktop`.
  Desktop, VS Code and every release channel use the SAME existing `.blackhole`
  database/config/account/tool profile. WebView keeps `.blackhole/webview`.
  A v200 daemon still using that database blocks a second Core on another port.
  Tests isolate by changing HOME/USERPROFILE to a disposable user, not by using
  an alternative data-directory policy. See [single-root storage](../../installers/STORAGE-SINGLE-ROOT.md).

## Build a fresh unsigned test layout

From `BlackHole-core`, only in an approved native-build environment, supply a
verified **Core v2 code archive**, its **public** key and one independently
verified Node distribution with its license. Required packaging inputs are:

```text
--seed <signed-core-v2.zip> --public-key <public.pem> --key-id <trusted-key-id>
--manager packages/host-runtime/dist/core-manager-cli.mjs
--output <fresh-directory> --environment test
--node-exe <absolute-node.exe> --node-sha256 <expected-sha256>
--node-license <absolute-LICENSE> --node-license-sha256 <expected-sha256>
```

Pass these options to `node scripts/package-desktop.mjs`; a v1 self-contained
Core is no longer accepted for new distributions. The packager checks Node
platform/version/SQLite and hashes, delivers Node and license only once, and
keeps the same signed Core ZIP available to the VS Code adapter. It never strips
members from an already signed archive. Output must be fresh.

The native runtime integration currently has synthetic layout/cache tests and
Inno syntax checks. Do not run a blocked native candidate or invoke the native
smoke against real user data. See
[host-node packaging acceptance](../../installers/HOST-NODE-PACKAGING-20261017.md).

Windows packaging requires **go-winres.exe** on PATH in addition to Go. It
renders 16/24/32/48/64/128/256-pixel variants of the existing BlackHole tray
mark and embeds them in the fresh EXE's `RT_GROUP_ICON #1`. The packager
reads the resulting EXE resources back and refuses a missing/incomplete icon.
The native WebView window loads that same embedded group; the Inno Start-menu
shortcut and taskbar then inherit the EXE icon. No installed EXE is patched
in place.
`distribution-audit.json` is **audit metadata, not the runtime trust anchor**.
The launcher is unsigned; production trust begins with an approved signed
launcher/installer and release-owner-controlled public roots. No private key
is required or accepted by this test packaging command.

Optional `--iscc <absolute-path-to-ISCC.exe>` compiles
`installers/windows/desktop.iss`; it does not install it. Compiler/tool installation,
actual installation, registry/UI tests and production signing require their own
approved environment. An explicitly approved portable Inno 6.7.3 is now available
under `.tmp/toolchains/inno-6.7.3/compiler`; the integrated test installer build
passed without executing the installer. Its hash/compiler evidence is written
to the generated distribution audit and compiler log. Commercial-license status
is still unverified. See [Windows acceptance](../../installers/windows/ACCEPTANCE.md).

## Windows install directory and Core/Web updates (Test candidate)

Interactive first installation shows the directory chooser; Inno retains the
previous location for the same AppId on later upgrades. Silent installs do not
show the chooser. Test and production retain distinct installer identities and
mutexes but use the SAME `~/.blackhole` data and Core store, never alternate
business databases. Do **not** install the shell beneath BlackHole Core/Data.
Relocating an existing install is a separate reversible migration, not `/DIR`.

`blackhole.exe --apply-bundled-core --print` is the installer-only entry. It
verifies the compile-time-pinned signed Seed archive, provisions to Manager's
version store and either keeps an identical Core, performs a guarded cold
selection, or upgrades the running Core through `upgrade-core`. A running
upgrade requires the sole initiating lease, no other clients or active work,
compatible data schema/protocol, and Manager's signed guarded stop. Interrupted
and ambiguous operations retain their journals and refuse automatic retries.
`--provision-only` remains a distinct prepare/reuse command, **not** an
upgrade implementation.

The native Test/production tray offers **检查更新…**. It is deliberately disabled
unless the released binary embeds both an HTTPS update feed and a matching
Ed25519 verification key. To prepare a fresh *Test* candidate with these pins,
provide both `--update-feed` and `--update-public-key` to
`scripts/package-desktop.mjs`. The offline `scripts/sign-desktop-update.mjs`
publishes a signed manifest for a verified Test layout; never put its private
key in the repo, downloaded app or feed server. The updater stages a signed,
SHA-256-verified full installer, quits the native shell gracefully, and hands
over to an external helper that waits for shell exit before invoking Inno. The
Core is not force-stopped as an installer convenience.

**Release gate:** Inno copies the shell before its postinstall Core transaction.
If Core rejects an upgrade because VS Code, Web or an Agent is still active,
Core/data stay safe but the install is not a fully atomic Desktop/Core update.
Actual in-place upgrade, rollback/repair UI, installer interruption and signed
production distribution still need dedicated acceptance. See
[update architecture](../../installers/UPDATE-ARCHITECTURE.md).

## Commands and recovery

- `--print`: verify/provision, attach/start, print the secret-free receipt, detach
  this launcher instance and exit without UI. Core remains running.
- `--provision-only --print`: prepare/verify Core without starting the daemon.
- `--tray`, `--no-browser`, `--no-tray`, `--port N`: shell launch options. Use
  explicit isolated roots and a non-7306 port for development tests.
- `--repair-start --print`: inspect the configured data root's start guard.
- `--repair-start --confirm-repair --print`: explicit conservative recovery.
  Manager requires the exact target, refused port, positively dead recorded PID
  and no live lease, then archives the guard. It does **not** kill or restart.
  Missing PID, permission ambiguity, a live/reused PID, a foreign/silent listener,
  or changed target requires investigation; never delete the record manually.
- Default `--stop` fails closed. Protected Stop/Restart is not yet exposed here.

**退出 BlackHole 托盘** only cancels that client's heartbeat and attempts detach.
It does not stop/restart Core, run GC, remove data or close an independent native
window. Closing the last window likewise does not stop Core.

## Safe verification

```sh
pnpm test:host-runtime
pnpm --dir packages/host-runtime typecheck
go -C packages/desktop-launcher test -count=1 -skip TestRegistryAutostartRoundTrip ./...
go -C packages/desktop-launcher vet ./...
```

The skipped Windows test writes HKCU; do not run it in a real user profile.
The native smoke creates its own HOME/LOCALAPPDATA/Core/data, uses a non-production
port and a PATH without system Node, tests real native entry/Seed/reuse/tamper
rejection/exit and copied-shell replacement/removal, then shuts down only its
identity-matched test daemon. This is **not** proof of actual VSIX interoperability,
interactive WebView/tray/browser behavior, Inno repair/upgrade/uninstall, air-gapped
machine behavior or production signing. Those remain acceptance gates.

Legacy source-checkout discovery remains available only in an explicit
`-tags blackhole_dev` build **and** with `--legacy-dev`; it is never an automatic
managed fallback. Plain unbundled Go builds fail with `desktop_distribution_missing`.
The old development Stop must not be used as a shared-Core production lifecycle API.

See [Manager lifecycle](../host-runtime/LIFECYCLE.md) for protocol and failure semantics.
