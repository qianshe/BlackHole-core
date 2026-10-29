# Security policy

## Report privately

Use GitHub's [private vulnerability reporting](https://github.com/qianshe/BlackHole-core/security/advisories/new) for authentication flaws, sandbox escapes, credential exposure, unsafe workflow permissions, and other security issues. Do not disclose an exploit or credentials in a public issue, discussion, or pull request.

Include the affected version or commit, operating system and CPU architecture, a minimal reproduction using synthetic data, expected behavior, and impact. Never attach `auth.json`, `.env`, `.dev.vars`, browser cookies, session prompts/URLs, payment/card codes, private keys, user databases, or an unfiltered diagnostic archive. Report the location and type of a suspected leaked credential, not the credential itself.

## Supported versions

Security reports are accepted for the latest published extension and the current default branch. Older releases may require an upgrade; there is no guarantee of backports or response-time SLA. A green build or public source tree is not a certification that every host environment is safe.

## Boundaries

BlackHole executes agent-requested tools on a user's machine. Use the documented permission model and an isolated environment for untrusted code. Do not disable confinement or authentication to make a failed test pass. A public test must use synthetic accounts, temporary data, and no production privileges.

The Core repository contains the local product, protocols, and public verification material. Hosted Cloud authentication, billing, administration, infrastructure configuration, and signing secrets remain outside this repository. Do not move private Cloud source into Core to reproduce a failure.

## Maintainer response

Reproduce privately, assess impact, and coordinate a fix and disclosure. Revoke or rotate an exposed credential at its provider; deleting a commit or making a repository private does not undo prior disclosure. Verify the exact release artifact and its source commit before publishing an advisory or claiming a fix.
