## Problem and scope / 问题与范围

What does this change fix? Which files or environments are intentionally outside scope?

## Verification / 验证

State the source commit, exact commands, OS/architecture, results, and any skipped or failing checks. For a package report include its SHA-256 and selected environment; do not attach secrets.

## Release impact / 发布影响

Describe compatibility, migration, configuration, rollback, and native-platform impact. A passing source check is not an installed-VSIX or production-service acceptance test.

## Checklist

- [ ] This PR contains no auth.json, private deployment configuration, tokens, private keys, user database, or private Cloud implementation.
- [ ] Tests use isolated data and do not access real credentials or production payments.
- [ ] Existing tests and safety assertions were not disabled to obtain a green run.
- [ ] CI/metadata-only changes are separated from runtime logic, or the reason for combining them is explained.
- [ ] Third-party licenses and attribution are preserved.
- [ ] No Marketplace publication or Cloud deployment is triggered by this PR.
