# Contributing to BlackHole Core

English or Chinese reports and pull requests are welcome. This repository is the local Core product; the Cloud service implementation is maintained separately and is not required for public tests.

## Scope and workflow

Open a focused issue before a substantial design change. For vulnerabilities, use [SECURITY.md](SECURITY.md), not a public issue. Work on a feature branch, review the exact staged diff, and open a pull request against `main`. Keep GitHub/CI maintenance separate from runtime behavior changes where possible. Do not force-push `main` or merge the former monorepo's history into this repository.

Use the package manager declared by `package.json` and the Node version in the workflow. Install with `pnpm install --frozen-lockfile`. Run the checks relevant to the changed files; the workflow definitions in `.github/workflows/` are authoritative. The CI scopes and manual release checks are explained in [.github/CI.md](.github/CI.md).

## Evidence in a pull request

Describe the problem, minimal change, affected environments, command results, failures/skips, and rollback considerations. Include the exact source commit and VSIX hash when reporting packaged behavior. A platform-simulated unit test is not evidence of native execution on that platform. Never weaken an assertion or use a permissive execution mode solely to obtain a green result.

Public CI checks out this repository only. Do not add private Cloud checkouts, production login sessions, deployment credentials, Marketplace tokens, or publishing steps to normal PR tests. Use isolated fixtures. Untrusted contributions must not execute on a maintainer's personal self-hosted runner.

## Private data and generated files

Do not commit authentication files, `.env`/`.dev.vars`, signing private keys, payment records, local user databases, runtime caches, or migration backups. Public service origins and verification public keys belong only in their reviewed client configuration. Never submit a whole home directory or an unfiltered diagnostic archive.

Keep generated VSIX/executable artifacts out of source commits. A successful build does not publish a Marketplace release or deploy Cloud.

## Licensing and attribution

BlackHole is licensed under the [Apache License 2.0](LICENSE). Unless you state otherwise, a contribution you submit is licensed under the same terms (section 5 of the license). Submit only code and documentation you have the right to contribute, and preserve third-party copyright notices and their licenses. When you add or upgrade a runtime npm dependency, run `pnpm licenses:third-party` and commit the regenerated `packages/vscode/THIRD_PARTY_LICENSES.md`; CI fails when it is out of date.

