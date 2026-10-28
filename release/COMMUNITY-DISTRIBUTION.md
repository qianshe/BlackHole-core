# Community Desktop distribution — 2026-10-28

## Goal and scope

Publish production-connected community Desktop installers for Windows x64,
macOS x64/arm64 and Debian/Ubuntu Linux x64/arm64. Keep online sales closed.
Retain the published 0.4.30 bytes; build 0.4.31 from one committed source.

The owner explicitly chose distribution without an Apple developer account
and accepted OS publisher warnings. This changes the vendor-certificate policy,
not Core trust, update signatures, installer transactions or artifact readback.

## Signing policy

- Windows: no Authenticode publisher certificate; disclose this in release/install notes.
- macOS: verify an ad-hoc app signature without recursively rewriting pinned Node;
  no Developer ID, no Apple notarization, no claim of default Gatekeeper trust.
- Linux: signed Core and signed update metadata, declared WebKitGTK runtime dependencies.
- Keep the existing production Core/update key pairs; never rotate trust roots as a side effect.
- No global Gatekeeper-disable or recursive quarantine-removal command in user instructions.

Primary references examined:
- https://rustdesk.com/docs/en/client/mac/ — DMG installation and app-specific system approval.
- https://github.com/mifi/lossless-cut/blob/master/README.md — separate Intel/Apple Silicon DMGs.
- https://support.apple.com/102445 — app-specific Open Anyway and different corruption/malware alerts.
- https://support.apple.com/en-sa/guide/security/secebb113be1/web — ARM64 can use an ad-hoc signature.

These examples establish distribution patterns; they do not establish that
other projects' current releases are unsigned or exempt from Gatekeeper.

## Candidate source security review

Reviewed the packaging trust boundaries against parent 06915104960a80131e2b926eefd62898278e444b:
- Production selects production secret NAMES before resolving values; empty secrets fail.
- Core Ed25519 verification and Node executable/license hash pins remain mandatory.
- Signing keys stay in a temporary directory removed by a trap and excluded from artifacts.
- GitHub version assets remain immutable; no production clobber or implicit Cloud deployment.
- Ad-hoc signing verifies the whole app and checks that all compiler-pinned payload hashes are unchanged.
- The native installer smoke refuses to execute outside a disposable GitHub Actions runner.
- No live local installation, user-profile deletion, payment setting or Cloud migration is performed.
- Focused policy/signing checks: 19 passed locally on 2026-10-28.
- Production dependency audit: no high/critical findings; one moderate qs advisory remains
  (GHSA-6pq8-jhm2-2vcw, comma-array stringify). No arrayFormat/comma stringify call occurs
  in tracked application source. This bounded review does not claim an independent security audit.

This evidence permits CANDIDATE builds only. Installer and download acceptance
must be recorded from the actual bytes before public release.

## Release sequence and evidence

1. Native source tests -> five signed production candidate packages.
2. On each native runner: real installer/extraction, pinned Node check, Core provisioning,
   headless health, reinstall and uninstall retaining isolated user data.
3. Review five receipts and artifacts; interactive UI acceptance is reported separately.
4. Prepublish gate checks installer evidence and explicit community signing disclosure.
5. Upload GitHub assets, download and verify their real bytes.
6. Generate catalog from verified signed manifests; deploy Cloud with sales still closed.
7. Read all Cloud download feeds and installer bytes, then complete the final release gate.

The Cloud readback gate belongs after assets/catalog exist. Prepublish defers
only that gate; a final release check still requires it.
