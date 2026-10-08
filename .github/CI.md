# CI guide

## Workflows

| Workflow | Automatic runs | Manual options |
| --- | --- | --- |
| [Core Runtime CI](workflows/vscode-extension.yml) | PRs and pushes to `main` | Run the complete matrix |
| [Desktop launcher CI](workflows/launcher-native.yml) | PRs changing the launcher, host runtime or contracts | `build_artifacts=true`: build development executables after tests |

Open **Actions → the workflow → Run workflow**, select the intended ref and enable the required options. Manual options are off by default. The desktop workflow does not repeat its PR checks on the merge push.

## Coverage and results

Runtime checks cover Windows x64, Linux x64/ARM64 and macOS Intel/ARM64; skill, prompt, guide-workflow, cloudflared installer and phone-entry probe regressions run inside each Runtime target. OpenAI runtime additionally runs on Windows ARM64, but complete Core execution is not verified there. Real cloudflared downloads are checked locally with `BH_CLOUDFLARED_LIVE=1`. Exact commands, runner versions and prerequisites are defined in the workflow files.

The **Audited VSIX smoke** job builds a production-profile candidate on Windows x64 (public origin/key only), independently audits the archive, then launches the *packaged* daemon under isolated temporary user/data directories. It does not install, upload, sign or publish an extension. **Shared settings browser** runs both production Web and native settings renderers on Linux x64 with a pinned headless Chromium, synthetic services, and 1280/390/320px viewport assertions. Both jobs must succeed for `Core CI` to pass. For local browser testing, install the browser once with `pnpm exec playwright install chromium` and then run `pnpm test:settings:browser`.

Only an explicit list of root and community documentation files can skip the Core native matrix. Runtime instructions under `src/` and `scripts/` still trigger checks. `Core CI` aggregates the required jobs; failures, cancellations and unexpected skips must not be treated as acceptance. Sandbox and file-link prerequisites remain mandatory.

A run validates its checked-out commit, not local uncommitted changes. Source CI does not replace installation, interactive login or release-artifact acceptance; use the [release checklist](../RELEASE-VALIDATION.md).

## Security and resource limits

Normal jobs use `contents: read`, isolated fixtures and standard hosted runners. They must not check out private Cloud code, receive production or Marketplace credentials, publish a release, or deploy a service. Do not execute untrusted code through `pull_request_target`, privileged `workflow_run` jobs or personal runners.

Jobs have timeouts; newer pushes cancel obsolete runs for the same PR/ref. Failure diagnostics include only the configured JSON files and expire after three days. Optional desktop artifacts expire after seven days. Never upload a home directory, complete cache, authentication file or private configuration.

Action references currently use major-version tags. Pin them to verified full commit SHAs before enforcing a SHA-only policy. Review action updates separately from application dependency changes.

## Maintainer setup

Use PRs for `main`, disallow force-push/deletion, and resolve review conversations. A second reviewer is not required for solo maintenance. After the new workflow has run successfully, bind its observed `Core CI` result as a required status check; optional manual workflows should not block unrelated PRs.

Repository protections and workflow files are separate settings. Check GitHub's actual protection rules when diagnosing a blocked merge. Private Cloud verification remains in its own repository.
