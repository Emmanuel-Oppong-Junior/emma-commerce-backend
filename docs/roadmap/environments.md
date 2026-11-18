# Environments and secrets inventory

Step 0 of the migration strategy (ADR-0017, P0-F.3). It lists every database known to have run the Prisma schema, and where credentials have leaked. Built from what the repository shows (CI workflow, Dockerfile, test scripts, git history) plus Emmanuel's answers. Values are never recorded here, only names.

**Real data:** no environment holds real customer or payment data (Emmanuel, 2026-11-16; `docs/audit/SUMMARY.md` question 7g). So ADR-0017 takes the re-baseline path at the Prisma 7 upgrade, and dev and test databases can be reset instead of reconciled.

## Databases that have run the schema

| Environment | Where | Database | Lifetime | Real data | Source |
|---|---|---|---|---|---|
| Local development | Developer machine, `localhost` Postgres | Name in the local `.env` `DATABASE_URL` (not read) | Long-lived | No | `.env` (untracked); the connection string once tracked in `.claude/settings.local.json` points at `localhost` |
| Local e2e tests | Docker container `emma-e2e-pg` on the developer machine (host port 5433) | One `*_test` database per test run or worktree agent (for example `emma_wt_deps_test`) | Disposable | No | Agent e2e workflow; `test/setup.ts` refuses a database name not ending in `_test` |
| CI e2e | GitHub Actions `postgres:16` service, `e2e` job | `emma_commerce_test` | Destroyed after each run | No | `.github/workflows/ci.yml` |
| Hosted (staging, production, preview) | None in the repository: no compose file, deploy config or hosted URL | Unknown | — | — | **Emmanuel to confirm** that no hosted database has ever run the schema |

Not counted: the CI `docker` job's `emma_smoke` database. The image starts with `node dist/main.js` and never runs `prisma migrate`, so that database stays empty.

## Known leaked credentials

| What | Where | Status |
|---|---|---|
| Keys in the `.env` committed in the first commits | Git history only; file deleted in `bcbae7b` (reachable from `origin/main`) | Fingerprints are in `.gitleaksignore`. **Emmanuel to confirm** the Paystack/Cloudinary/OAuth keys from that file were rotated or were test keys |
| Local database password in `.claude/settings.local.json` (SEC-05/OPS-18) | Git history only; untracked in `3cc1a89` and listed in `.gitignore` | Local-only database, so no rotation (Emmanuel). Not flagged by the scanner: the password's entropy is below the custom rule's floor |

## Secret scanning

The `secrets` CI job runs gitleaks (pinned binary, SHA-256 checked) on the commits of each push or pull request, using `.gitleaks.toml` (default rules plus a connection-string rule). When there is no usable base commit it scans the whole history. `.gitleaksignore` holds the fingerprints of the findings above, the fake test fixtures and the documentation placeholders already in history, so the full scan stays green. A new finding fails the job. If it is a false positive, add `gitleaks:allow` on that line, or add its fingerprint to `.gitleaksignore` with a comment.
