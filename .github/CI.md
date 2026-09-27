# CI guide

## Workflows

| Workflow | Automatic runs | Manual options |
| --- | --- | --- |
| [Core Runtime CI](workflows/vscode-extension.yml) | PRs and pushes to `main` | Run the complete matrix |
| [Cloudflared Install CI](workflows/cloudflared-install.yml) | PRs affecting the installer or its dependencies | `live_downloads=true`: verify real upstream downloads |
| [Desktop launcher CI](workflows/launcher-native.yml) | PRs affecting the launcher, bootstrap or shared inputs | `build_artifacts=true`: build development executables after tests |

Open **Actions → the workflow → Run workflow**, select the intended ref and enable the required options. Manual options are off by default. Installer and desktop workflows do not repeat their PR checks on the merge push.

## Coverage and results

The skills matrix covers six OS/architecture combinations. Runtime checks cover Windows x64, Linux x64/ARM64, macOS Intel/ARM64, and a separate macOS 26 ARM target. Windows ARM64 has skills/protocol coverage only, not full native execution support. Exact commands, runner versions and prerequisites are defined in the workflow files.

Only an explicit list of root and community documentation files can skip the Core native matrix. Runtime instructions under `src/` and `scripts/` still trigger checks. `Core CI` aggregates the required jobs; failures, cancellations and unexpected skips must not be treated as acceptance. Sandbox and file-link prerequisites remain mandatory.

A run validates its checked-out commit, not local uncommitted changes. Source CI does not replace installation, interactive login or release-artifact acceptance; use the [release checklist](../RELEASE-VALIDATION.md).

## Security and resource limits

Normal jobs use `contents: read`, isolated fixtures and standard hosted runners. They must not check out private Cloud code, receive production or Marketplace credentials, publish a release, or deploy a service. Do not execute untrusted code through `pull_request_target`, privileged `workflow_run` jobs or personal runners.

Jobs have timeouts; newer pushes cancel obsolete runs for the same PR/ref. Failure diagnostics include only the configured JSON files and expire after three days. Optional desktop artifacts expire after seven days. Never upload a home directory, complete cache, authentication file or private configuration.

Action references currently use major-version tags. Pin them to verified full commit SHAs before enforcing a SHA-only policy. Review action updates separately from application dependency changes.

## Maintainer setup

Use PRs for `main`, disallow force-push/deletion, and resolve review conversations. A second reviewer is not required for solo maintenance. After the new workflow has run successfully, bind its observed `Core CI` result as a required status check; optional manual workflows should not block unrelated PRs.

Repository protections and workflow files are separate settings. Check GitHub's actual protection rules when diagnosing a blocked merge. Private Cloud verification remains in its own repository.
