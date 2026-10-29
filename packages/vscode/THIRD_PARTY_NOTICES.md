# Third-Party Notices

BlackHole — Web Agent Bridge includes or bundles third-party components. Their licenses remain independent from the Apache-2.0 license covering BlackHole. The npm packages bundled into the extension, background service and Local Web UI, with their license texts, are listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## Koffi

- Component: `koffi` and its per-platform native packages (`@koromix/koffi-<platform>-<arch>`)
- Version in the current build: 3.2.1
- License: MIT
- Project: https://koffi.dev/
- Distribution: the runtime loader, native module, package metadata and upstream LICENSE files are copied into the VSIX where required by the Windows sandbox chain.

## Semantic search-derived code

Parts of BlackHole semantic search are derived from `SammySnake-d/fast-context-mcp` v1.3.2.

- License: MIT
- Project: https://github.com/SammySnake-d/fast-context-mcp
- Distribution: the upstream MIT license and BlackHole attribution notice are shipped as `dist/daemon/LICENSE-MIT` and `dist/daemon/semantic-NOTICE.md`.

BlackHole exposes `contextsearch` only when a Devin Key is configured. The current implementation uses Devin Fast Context; code context required for a search is sent to that service. Devin is not bundled with or licensed by BlackHole, and use of that service is subject to Devin's own terms and privacy policy.

## cloudflared

The universal VSIX does **not** distribute cloudflared. Users who need Cloudflare channels install the connector separately from https://developers.cloudflare.com/tunnel/downloads/ and remain subject to its upstream Apache-2.0 license and notices.

## Local sandbox implementation

The local platform sandbox work references the MIT-licensed `deepseek-ai/deepseek-harness` project. Preserve its copyright and license for ported or derived portions; the full MIT text is included in `licenses/deepseek-harness-MIT.txt`.

- Upstream: https://github.com/deepseek-ai/deepseek-harness
- Copyright (c) 2026 DeepSeek
- License: MIT
- BlackHole changes: integration with session permission modes, private command temporary directories, explicit environment handling, lazy Windows native loading and failure-closed checks.

This attribution does not imply affiliation or endorsement.

## Scope

BlackHole Cloud, authentication, account/subscription services, payment integrations, administrator services and deployment configuration are separate server-side components. They are not in this repository and are not covered by its Apache-2.0 license.

