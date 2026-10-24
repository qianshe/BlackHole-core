# Managed Core lifecycle — development seam

This seam is implemented in `src/core-lifecycle.ts` and exposed through
`dist/core-manager-cli.mjs`. It is not a finished Desktop installer, an online
migration API, or permission to stop a production daemon.

## Boundary

The Manager owns selection, signature/content verification, data-root identity,
start/attach, inventory, leases, known-good records and GC retention. Desktop's
`internal/coremanager` package is only a bounded JSON subprocess transport; it
has no daemon spawn, store editing, runtime discovery or legacy fallback.

The default native entry now uses `internal/distribution` to verify compiled-in
bootstrap hashes and supply absolute Node/Manager/store/public-trust paths.
Manager provisions offline Seed only after verified running/active/known-good
reuse is ruled out. Native window/tray leases and browser fallback use this
seam; legacy code is explicit developer-build-only, never an automatic retry.
Headless packaged-native acceptance has passed; actual interactive UI and Inno
installation/repair/upgrade/uninstall have not. See the Desktop README.

## JSON stdin commands

- `{"command":"attach-or-start","request":{"client":...,"port":...}}`
  returns `{receipt, lease, spawned}`. `client` includes `clientId`, a UUID
  `clientInstanceId`, `kind` (`desktop`/`vscode`), `version`, supported `protocol`
  and required `capabilities`. `readyTimeoutMs` is optional (default 30 seconds,
  maximum 60 seconds). Mutable data paths come from the canonical resolver and
  Manager environment, never from a client-supplied daemon entry or URL.
- `{"command":"heartbeat","request":{"handle":...,"port":...}}`
  verifies the live managed identity before renewing the existing 45-second
  lease. An expired, detached or target-mismatched lease is not resurrected.
- `{"command":"detach","handle":...}` removes only the matching lease and is
  idempotent if already absent. It needs no daemon request or trust-key file.
  It never stops Core, changes active/known-good, runs GC, or deletes user data.

A handle contains `leaseId`, `clientInstanceId`, `daemonId`, `dataRootId` and
`descriptorHash`. It binds a target; it is not an authentication secret and
never authorizes Stop. Replies use `{ok:true,result:...}` or
`{ok:false,error:{code,message}}`. Input/output are bounded to 1 MiB; the new
managed receipt is strict and never contains a login ticket or access token.

### Provisioning, recovery and browser commands

- `{"command":"ensure-core","request":{"client":...,"port":...,"seedArchive":...,"seedArchiveHash":...}}`
  reuses verified recorded-running/active/known-good before reading Seed. If
  needed, it verifies the optional archive pin and signed archive, provisions
  transactionally, rechecks selection under locks and activates only if absent.
  It never starts a daemon or performs legacy migration. Desktop supplies its
  compiler-pinned Seed hash; the direct provisioning API still verifies signatures.
- `{"command":"inspect-start"}` returns the canonical data root's record or null.
- `{"command":"recover-start","request":{"confirmed":true,"dataRootId":...,"descriptorHash":...,"startFingerprint":...}}`
  archives only a provably dead, unused exact target and returns `{recovered}`.
- `{"command":"open-browser","request":{"handle":...,"port":...}}` validates and
  renews the managed lease, obtains a bounded loopback-only fresh ticket, opens
  a private redirect filename and schedules finite cleanup using verified Store
  Node. No legacy start, ticket URL in argv, ticket response text in errors, or
  bootstrap Node held open for the cleanup minute. Failed cleanup can also be
  swept on the next attempt; the server-side ticket lifetime still applies.

## Safety and recovery behavior

- Lock order is **install then lifecycle**. Verification and start/ready/lease
  persistence run under both; activation takes the same order. A positive
  `lock_busy` response may be retried after contention resolves. Neither the
  Go adapter nor Manager blindly retries an ambiguous mutation.
- A recorded running Core wins over a newer active pointer. Otherwise select
  active, then known-good only if active is absent. Broken pointers do not
  silently fall back. Startup does not activate another version or downgrade.
- Re-verify the installed descriptor signature, environment/platform, declared
  members and hashes before using it. Reject links, undeclared members and
  mutable data roots/DBs inside the Core store. Use the selected Core's Node
  and daemon, strip Node/Electron injection variables, and derive Web assets
  from the verified descriptor.
- Only an explicit loopback `ECONNREFUSED` permits an initial start. An existing
  legacy/foreign/malformed/unresponsive listener does not. Health must match
  runtime/build/descriptor/data-root/DB/protocol/environment/cloud/Web identity;
  readiness also checks `/ui/`. A managed fingerprint binds later observations.
- A `state/running/<dataRootId>.json` record is written **before** spawn, and the
  owned PID is recorded when available. Timeouts, crashes and ambiguous results
  preserve this record. A compatible late-ready instance may be attached; a
  down endpoint with a prior record returns `daemon_state_unknown`, rather than
  spawning again. `inspect-start` and confirmed `recover-start` provide a
  conservative repair path: exact dataRootId/hash/fingerprint, refused port,
  positive ESRCH for the recorded PID, and no live lease are all required.
  Recovery archives the guard; it never kills or restarts. Unknown/missing PID,
  a live/reused PID, foreign listener, timeout, or changed target remains blocked.
  Do not delete such records as a repair shortcut or kill by PID alone.
- GC retains recorded running and ambiguous-start Core versions after every
  client has detached. Corrupt lifecycle state blocks deletion. A lease is not
  proof that it is safe to stop a daemon, and inventory is not liveness evidence.
- Go `KeepAlive` renews at 15 seconds and attempts detach with a fresh bounded
  context when cancelled or disconnected. No failure path invokes Stop or an
  alternate runtime. Transport ambiguity is returned as `UnknownOutcome`.

`register-client`, `write-lease`, `activate` and the existing migration commands
remain available for the bridge. New Desktop code must use the managed seam,
not invent leases with the raw bridge command. Shared Core bridge identity now
uses `resolveDataPaths` (including the `blackhole-data-root-v1` namespace), not
a separate bare path hash. Physical path aliases are canonicalized by the new
Manager; full native bridge/alias/multi-window acceptance is still a release gate.

## VSIX Manager-only development integration (2026-10-12)

Bridge builds now explicitly advertise `blackholeSharedCore.mode=bridge` and
use `ManagedCoreSession` for ensure/attach, 15-second heartbeat, identity checks
and awaited own-lease detach. Desktop-first and fresh installs do not run legacy
Stop; unreadable Manager state does not authorize fallback. This paragraph
records the historical v1 bridge. New 0.4.0 distributions use explicit host-node
mode below; a missing Seed is no longer permission to use a private daemon.

### Runtime-neutral Core v2 — actual lightweight packages, not yet released (2026-10-17)

Signed descriptor format 1 continues to require and verify nodeEntry. Format 2 declares runtimeProvider=host-node and nodeMinVersion and rejects any node/ member. Manager's verified v2 Core runs under the executable hosting the Manager process: a Desktop-supplied Node, or a VS Code Electron/Node process with ELECTRON_RUN_AS_NODE enabled. It checks the Node version, in-memory node:sqlite support and executable path before writing any startup record, and strips Node injection variables. All actual Core code/native modules/Web remain signed members. Starting, browser redirect cleanup, and v1 behaviors use the common runtime selector. Tested isolated v2 spawn, dual-client lease and Manager stop. Do not treat the signing metadata as permission for an arbitrary runtime executable from user input.

ensure-core accepts an omitted seedArchive for reuse of a verified existing Core. Without one, it returns core_missing; only this conclusive result permits the native VS Code bootstrap to acquire its immutable, hash-pinned v2 archive. Thin mode prompts and downloads code (never Node), while offline-code mode uses its one embedded v2 archive. Both contain pinned Manager/trust/reference files and skip all old bridge/legacy startup logic. Actual review packages are 503,326 and 3,340,284 bytes respectively. The same actual Manager/Core passed headless checks using system Node and the installed VS Code Electron/Node. Desktop packaging now supplies one separate pinned Node plus license and prepares its stable content-addressed runtime cache. SQLite is imported only when a new v2 spawn actually needs it. These are tested local sources/packages, not approved production release or VS Code UI acceptance; see installers/HOST-NODE-PACKAGING-20261017.md. The existing v0.3.200 service must not be switched until explicitly accepted.

`activate-cold-core` takes `{request:{versionName,port}}`. Under install/lifecycle
locks it re-verifies the candidate and requires no recorded target, no live
lease for that data root, and a positively closed listener before changing
pointers. Slow health responses after **our already-recorded single spawn** may
be observed again within readiness timeout; initial unknown listeners still
block any spawn. Unknown outcomes are not permission to repeat a mutation.

The earlier packaged candidates still refuse managed Stop/Restart. Current
source now has explicit coordinated maintenance, described below; packaged and
GUI acceptance remain pending. Legacy payloads are historical test-only paths;
new host-node packages omit them. Desktop and VS Code now share the sole
HOME/.blackhole data/Core root and default7306, including Test builds.

`scripts/vscode-manager-smoke.mjs` exercises two actual adapter instances plus
the pinned packaged Desktop CLI and real test-signed Core, waits 50 seconds,
and verifies renewal, independent detach and unchanged daemon identity. This
is stronger than a synthetic client-kind probe, but not VS Code GUI acceptance.
The current v2-specific `host-vsix-manager-smoke.mjs` separately verifies actual
offline-code initialization, thin client reuse, lease refusal, normal Stop and
SQLite preservation; it can run under VS Code's own Electron in Node mode.
See `installers/windows/INTEGRATION-20261012.md` for artifact identities and gates.

## Protected maintenance source implementation (2026-10-12)

The current source adds the native Manager seam:

- `{"command":"maintain-core","request":{"operation":"stop|restart","confirmed":true,"requestId":"<UUID>","client":...,"handle":...,"port":...}}`
- `{"command":"inspect-maintenance","requestId":"<UUID>"}`
- `{"command":"recover-maintenance","request":{"confirmed":true,"requestId":"<UUID>"}}`

The operation is explicit, instance-bound, and serialized under install then
lifecycle locks. A live own lease, no other live leases for the data root, a
verified installed Core, exact health identity and lifecycle-control capability
are required. Restart pins the original version even when active has advanced.
The external CLI no longer offers raw lifecycle-token mint/consume commands.

Manager injects only its per-user authority **public key** at spawn. Core checks
an Ed25519 grant with at most 30 seconds of lifetime, one-use nonce, transaction,
daemon/fingerprint/runtime/build/descriptor/data-root binding, and native
loopback request constraints. It checks tools including approval/queue waits,
nonterminal/unknown processes, pending approvals, MCP, Courier including
pre-hello sockets, HTTP responses and returned asynchronous handler promises.
Disconnecting a response does not hide an unfinished handler. The idle check
and admission seal have no intervening await. Legacy native shutdown/restart,
self-restart, and Local Web Stop reject managed instances; browser Stop has no
coordinated Manager UX yet and must not fall back to a direct shutdown.

`state/maintenance/<requestId>.json` is written before POST. Only a positive
closed-port observation **and** ESRCH for the recorded PID allow guard removal
and own-lease deletion. Lost/malformed replies, foreign listeners and unknown
exit states preserve recovery state; the code never force-kills. Pending
transactions block ordinary attach/start and cold activation and pin the target
against GC. Inspect before retrying; repeating a recorded request ID is refused.
Explicit recovery requires a dead, unused, exact target and never restarts.
A different replacement guard is not removed as if it were the original target;
its exact startup recovery must be resolved separately before old maintenance
can be reconciled. Do not delete journal files to bypass these checks.

VSIX command-palette Stop/Restart now have modal confirmation and bind the target
observed before the dialog. Maintenance waits for renewal and close waits for
maintenance; unknown outcomes suppress automatic attach/renew/retry. A restart
receipt must identify a fresh incarnation and lease of the same pinned Core.
Configuration watchers do not stop shared Core or apply window-local launch
parameters; port changes require Manager-owned configuration coordination.
Full configuration application and maintenance recovery UX remain open gates.

Current-source evidence: VSIX 473 pass / 2 skip / 0 fail (475 total), Host 59/59,
contracts 41/41, server/activity/process/native route group 65/65, and independent
version-transition/Web-Stop/packaging/data-path group 16/16. Groups overlap.
Core build, Host/VSIX typechecks and diff-check pass. See
`installers/windows/MAINTENANCE-20261012.md` for logs and limits.

**Existing packaged Seed/Desktop/VSIX artifacts predate these changes.** They
must be rebuilt together and revalidated before manual acceptance. The real
source-daemon subprocess test is isolated and does not prove installed GUI,
installer execution, production signing or publication.

## Verification

From `BlackHole-core`:

```sh
pnpm test:contracts
pnpm test:host-runtime
pnpm --dir packages/host-runtime typecheck
node --test packages/vscode/test/shared-core-manager.test.mjs scripts/data-paths.test.mjs scripts/core-runtime.test.mjs
go -C packages/desktop-launcher test -count=1 -skip TestRegistryAutostartRoundTrip ./...
go -C packages/desktop-launcher vet ./...
```

The existing registry autostart test is deliberately excluded outside an
approved isolated Windows account. `TestIsolatedManagerCLI` normally skips;
run it explicitly with the smoke driver below, not against a real profile.

For the existing Windows x64 **test-signed** 0.3.201 Seed (no private key needed):

```sh
pnpm build
pnpm --dir packages/host-runtime build
go -C packages/desktop-launcher test -c -o ../../.tmp/launcher/desktop-manager-probe.exe ./internal/coremanager
node scripts/desktop-manager-smoke.mjs .tmp/core-bridge-0.3.201.zip .tmp/core-test-keys/public.pem .tmp/launcher/desktop-manager-probe.exe
```

The driver provisions a fresh temporary Store, isolates HOME/USERPROFILE/
LOCALAPPDATA/APPDATA and data paths, chooses a random non-7306 port, removes
system Node from the probe PATH, and runs **Go adapter → current Manager CLI →
real Seed Node/daemon/Web**. Desktop-kind and VS Code-kind requests must share
identities, and all detach operations must leave the daemon running. Cleanup
uses identity-bound shutdown only for the isolated daemon. Unknown cleanup is
reported and retained, never treated as permission to kill an unrelated PID.

This uses the fresh development Manager with the existing signed Seed; it does
not claim that the Seed's embedded Manager has been repackaged. It does not run
an actual VS Code extension host, native Desktop UI, offline installer, repair,
upgrade or uninstall. The test probe executable is not a distributable app.

## Remaining gates

Trusted first-stage/Seed handling, default native wiring and conservative
explicit recovery are implemented and tested at the headless/helper level.
Protected maintenance packaging and recovery/configuration UX, actual interactive UI/browser behavior, installed
per-user Inno repair/upgrade/uninstall, real VS Code upgrade/reload/
multi-window interoperability, production signing and release verification
remain gates. Production roots must come from the approved signed distribution,
not an arbitrary test trust configuration. No rollout is performed by these
tests. Test-flavor Inno compilation has now passed with the approved portable
toolchain; the generated installer has not been executed. See
`installers/windows/ACCEPTANCE.md` for the pending matrix.

## Configuration and native maintenance increment (2026-10-13)

This section extends the earlier source-stage contract; **the previously listed
Seed/Desktop/VSIX/installer remain stale**. See
`installers/windows/CONFIGURATION-20261013.md` and plan §13.21 for evidence and
unresolved native GUI/Web/product-upgrade gates.

### Authoritative endpoint and existing-only attachment

- `resolve-endpoint`: `{request:{fallbackPort}}` returns
  `{schemaVersion:1,dataRootId,port,revision}`. A saved endpoint wins; otherwise
  the run record or fallback supplies revision zero. Corrupt/inconsistent state
  fails closed. Test endpoints may not use 7306.
- `configure-endpoint`: `{request:{confirmed:true,expectedPort,expectedRevision,port}}`.
  This is a cold CAS under Manager locks. No run record, live data-root lease or
  unresolved maintenance may exist; both ports must be positively closed. No
  implicit Stop, spawn, force, or fallback around an unknown listener is allowed.
- Endpoints live in `manager.state/endpoints/<dataRootId>.json`. This is routing
  ownership, not a second arbitrary environment/settings store.
- `attach-or-start` accepts optional `request.existingFingerprint`. When supplied,
  the same lock must see that exact ready incarnation; absence/change refuses
  before any cold launch. Desktop maintenance uses this atomic existing-only
  seam, not a racy inspect followed by an unrestricted start.

### Revision-bound configuration application

`maintain-core` may include `request.settingsRevision` on **restart only**.
Core must advertise `lifecycle_settings_version:1`; current revision is checked
before signing and again at the synchronous shutdown admission seal. The signed
grant carries the expected revision. After a same-version replacement, both its
`started_settings_revision` and current `settings_revision` must equal the
requested revision; otherwise retain the unknown/recovery journal.

SQLite SettingsStore remains authoritative for saved/seeded settings. The
managed settings view includes `{managed:true,application:{started_revision,
restart:'manager-confirmation',port:'manager-cold-change'}}`. Actual startup
values, rather than a copy of desired values, determine pending restart fields;
unseeded fields preserve the prior migration mechanism. An explicitly empty
managed cloudflared path clears the inherited override. Independent credential
files are not covered by the settings revision.

### Explicit recovery of a live replacement

`inspect-maintenances` lists this data root's unresolved journals. The existing
`recover-maintenance` dead-target operation still requires positive closure and
PID death, no live leases, and exact guard matching; it never kills or starts.

Optional `request.currentFingerprint` selects a different, explicit operation:
acknowledge the **observed ready replacement** of a restart. It requires a fresh
matching run fingerprint, the same pinned version/hash/database/port, positive
old-PID death, a live recorded current PID, verified installed members and exact
new health identity. It preserves run guard and leases, performs no process or
configuration mutation, and writes terminal journal state `recovered_running`.
The result additionally has `observed:'running'`. This does **not** confirm that
the original requested configuration was applied. Wrong targets stay blocked.
Live leases do not block this non-process-mutating acknowledgement.

VSIX exposes apply, cold-port configuration and inspection/recovery as native
confirmed commands; accepting a replacement requires a second confirmation.
Recovery does not automatically reload/start. Desktop CLI exposes corresponding
confirmed operations, but full tray/window and browser-to-native handoff remain
pending. Busy handlers/clients, including the initiating UI's active connections,
are not exempted for convenience.

## Product upgrade transaction (2026-10-13)

`upgrade-core` upgrades the running managed Core to an already-provisioned
target version as one journalled transaction (`state/upgrade/<requestId>.json`):

- **Stage first.** Provision/verify the candidate while the old Core keeps
  running; provisioning never moves the active pointer or disturbs the daemon.
- **Precheck (nothing stops on refusal).** The requester must hold the only
  live lease; the target must be signature/member verified, protocol- and
  capability-compatible, strictly newer by runtime version, and able to read
  the current data-schema range. `migrationPolicy:'explicit'` candidates are
  refused (`data_migration_explicit_required`) — no automatic upgrade performs
  an explicit or irreversible migration.
- **Commit path.** The old Core is stopped only through the guarded
  maintenance path (own lease, idle, signed stop grant), the active pointer
  switches under Manager locks, and the candidate starts with the same data
  root/port. The transaction commits (`committed`) only after health, receipt
  identity and Web readiness verify; known-good moves only then.
- **Rollback.** A positively failed candidate (process exited, port closed)
  restores the previous pointer and restarts the previous verified Core; the
  result state is `rolled_back` with the previous Core's fresh attachment.
- **Ambiguity stays sticky.** A live or answering candidate, an unknown stop
  outcome, or a failed rollback leaves `recovery_required`; attach/maintain
  then refuse with `upgrade_recovery_required`, GC pins both versions, and
  `inspect-upgrades` lists the journal. Nothing spawns a second daemon and no
  process is ever killed by PID.

Desktop's Go adapter exposes the same transaction as `Client.Upgrade` with
strict result validation (committed must carry the target descriptor;
rolled_back must carry the previous descriptor and a fresh incarnation).
