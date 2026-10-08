# Core repository status

BlackHole Core is a public development repository. Cloud backend, production secrets, and the original monorepo history remain outside this repository. Publishing source does not publish an extension or deploy a service.

This page defines the repository boundary, not release acceptance. A remote CI run validates its checked-out commit; local uncommitted changes and previously built VSIX files require separate review.

The repository is licensed under Apache-2.0 (root [LICENSE](LICENSE) and [NOTICE](NOTICE)); third-party components keep their own licenses. The hosted Cloud service is not part of this repository. See [CI policy](.github/CI.md), [contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md) for the public workflow.

## Scope

The import includes the local daemon, MCP/session/permission code, Cloud protocol client and public verifier, VS Code extension, contracts, desktop launcher, host runtime and Local Web UI. It includes the captured in-progress source changes; the original worktree has not been reset, cleaned, staged or committed as part of the split.

Cloud backend/admin/payment implementations, live deployment profiles, credentials, internal documents, old Git history and build/cache files are not imported. The official Cloud issuer and verification key, subscription gate, VS Code publisher/name and deployed resources are unchanged.

## Current development

`main` is the integration branch. Core builds independently of private Cloud source and deployment profiles. Development commands are in [README.md](README.md#source-development); release configuration and artifact acceptance are in [RELEASE-VALIDATION.md](RELEASE-VALIDATION.md).

## Historical evidence

The repository began with an independent `migration/initial-import` snapshot. Initial-import test counts, limitations and failures remain in this file's Git history. They describe that snapshot, not the current working tree or release candidate. Use the relevant CI run and release record for current results.

Do not merge the former monorepo history or upload local migration archives into Core. Submit reviewed changes through a PR, and keep source integration, artifact publication and Cloud deployment separate.

