# Desktop publishing and automatic discovery

Normal Desktop releases need no Cloud source edit, credential or deployment.

1. Bump the product version and review/approve the release source as usual.
2. Run the production Desktop workflow with GitHub publishing enabled.
3. CI verifies all five native installers, Core signatures and production update pins.
4. CI generates `desktop-release.json` containing the five exact signed manifests, uploads it alongside every installer while the release is still a draft, then publishes it as GitHub Latest.
5. Cloud reads the fixed URL `https://github.com/qianshe/BlackHole-core/releases/latest/download/desktop-release.json`. The download page and both stable/legacy preview updater URLs use the same verified snapshot.
6. CI waits for metadata propagation, verifies the Cloud feeds and downloads all five real installer bodies to check their hashes. The published review is retained as an Actions artifact.

Cloud checks at most once per five minutes per warm isolate; HTML has a one-minute cache. Allow a few minutes for a new release to appear. Downloads retain version-specific URLs. Releasing does not silently install software on a user's machine.

## Trust and failure behavior

- Trust roots remain pinned in Cloud and the native client. Downloaded JSON cannot introduce a key.
- All five supported platform/architecture entries must be production, stable, signature-valid and share one version. Partial sets, duplicate targets, modified bytes, unsafe URLs and same-version identity conflicts are rejected.
- Draft/test/prerelease publishing does not promote a production release to Latest.
- Invalid metadata or GitHub outages retain the last verified snapshot in a warm isolate; cold starts fall back to the bundled verified baseline. Failed refreshes retry after 30 seconds.
- In-process discovery rejects older versions than its verified snapshot; native updater downgrade rejection remains in place. The bundled baseline also provides a minimum version.
- Local withdrawal records still override remote publication. Key rotation, a new supported target or an emergency withdrawal policy change may require an intentional Cloud update; routine version releases do not.
- Keep the latest production Desktop release marked Latest in GitHub; unrelated releases without this index are not Desktop publishing operations.
- Never overwrite a published installer or reuse its version. Recovery of a failed post-publish readback must inspect the existing release, not rebuild/clobber its assets.

## Initial rollout

The existing v0.4.31 release received only the new JSON metadata asset, assembled from its already-published, production-signed manifests. Its installer bytes, tag, keys, update addresses and UI remained unchanged. No payment capability is enabled by discovery.

Tests simulate v0.4.31 → v0.4.32 → v0.4.33 with unchanged Cloud baseline, validate website and both updater channels, and cover outages, incomplete indices, key substitution, size limits, withdrawals and concurrent cache refreshes.
