# Private Core migration candidate

Keep this repository private. This initial import is a source/development candidate, not a public release, Marketplace publication or deployment. Existing component licenses and notices are retained; this migration does not grant a new repository-wide license. Public-release review and licensing decisions remain separate.

## Scope

The import includes the local daemon, MCP/session/permission code, Cloud protocol client and public verifier, VS Code extension, contracts, desktop launcher, host runtime and Local Web UI. It includes the captured in-progress source changes; the original worktree has not been reset, cleaned, staged or committed as part of the split.

Cloud backend/admin/payment implementations, live deployment profiles, credentials, internal documents, old Git history and build/cache files are not imported. The official Cloud issuer and verification key, subscription gate, VS Code publisher/name and deployed resources are unchanged.

## Standalone development

The root workspace and lockfile contain only Core packages. `scripts/environment-config.mjs` now contains public client profiles only; it does not read private configuration files or expose deployment resource IDs. The deterministic default test profile uses an example domain and throwaway public key and cannot log in to the real service. An independent test service requires an explicit origin/public-key pair. See README for commands.

Universal VSIX packaging also needs `node scripts/fetch-keyring-prebuilds.mjs`. This explicitly retrieves the pinned native keyring packages and verifies registry SHA-512 integrity. Cache files are local/ignored, not Git content. Packaging does not install the extension, restart the active daemon, publish a release or deploy Cloud.

## Fresh local verification

Environment: Windows x64, Node.js 22.20.0, pnpm 10.0.0. Dependencies were installed independently from the existing package cache and the lockfile was pruned for Core.

- Daemon build/typecheck, VS Code typecheck/build, Local Web build, desktop launcher build and Go tests passed.
- Public build/flavor suite: 29 passed; shared protocol contracts: 8 passed.
- Local Web unit suite: 12 passed; account/settings/web-session/OpenAI tunnel suite: 32 passed.
- Settings suite: 196 passed; handoff suite: 87 passed.
- Skills suite: 70 passed, 1 skipped because Windows file-symlink privilege was unavailable; junction-boundary tests ran. Native file-symlink acceptance still needs a suitable environment.
- Host runtime: 3 isolation tests and 4 bootstrap tests passed.
- Universal test VSIX packaging and its archive audit passed after native prebuild preparation.

These are separate commands with overlapping coverage; do not sum them as unique tests. Non-Windows platform execution, complete live-service checks and a public-release security/licensing audit were not performed.

## Known inherited changelog mismatch

`pnpm test:changelog` currently fails. The package version is 0.3.181, but the unchanged source changelog has version sections 0.3.174, 0.3.173 and 0.3.171. The retained assertion requires a single note matching the current package version. This check was moved from the Cloud test package because it concerns the extension, and is now explicitly available as a Core script.

The changelog was not rewritten and the test was not weakened to make this migration green. Resolve release notes/version policy separately before publishing. This candidate does not claim that every test or release gate passes.

## Branch and handover

The initial private candidate is on `migration/initial-import`, with independent Git history. Do not merge the original monorepo archive into this repository. Production/main promotion, release publication and changing visibility require separate review. Existing CI workflows retain their main/PR triggers; importing this candidate branch alone does not prove a remote CI pass.
