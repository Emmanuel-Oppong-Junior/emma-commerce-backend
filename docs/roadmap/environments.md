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

## Observability

What each hosted environment must configure for P1-L. Values are never recorded here.

| What | Where | Notes |
|---|---|---|
| Logs | stdout of both processes | One JSON object per line (`timestamp` ISO UTC, `level`, `message`, `context`, `requestId`, `userId`, `jobId`, `queue`). Ship stdout to the log sink; nothing is written to disk outside development. `LOG_LEVEL` sets the level. |
| Request id | `X-Request-ID` response header | Search the logs and Sentry by it. A job queued by a request carries the same id. |
| Error tracking | Sentry project DSN in `SENTRY_DSN` | Off when unset. Set `SENTRY_ENVIRONMENT` (defaults to `NODE_ENV`) and `SENTRY_RELEASE` (image tag or commit). `SENTRY_TRACES_SAMPLE_RATE` stays 0 unless Sentry tracing is wanted. Only 5xx/internal errors and jobs with no attempts left are reported; no request bodies, headers, cookies or emails. |
| Metrics | `GET /metrics` on `METRICS_PORT` (default 9464) of every API and worker instance | Served by a separate listener, not the API port: keep it on the private network. Scrape the API as `job="emma-api"` and the worker as `job="emma-worker"` (the alert rules use these names). Give the two processes different ports if they share a network namespace (CI uses 9464 and 9465). `METRICS_ENABLED=false` turns it off. |
| Alerts | `ops/prometheus/alerts.yml` | Load into Prometheus (`rule_files`) and route `severity: critical` to paging, `warning` to chat. Check after edits: `promtool check rules ops/prometheus/alerts.yml`. |

**Drills.** `promtool test rules ops/prometheus/alerts.test.yml` replays synthetic series and asserts each alert fires (internal error rate, GraphQL p95, webhook settlement failures, failed jobs growing, stale outbox, worker dependency, target down). Run it with Docker from the repo root: `docker run --rm -v "$PWD/ops/prometheus:/rules" -w /rules --entrypoint promtool prom/prometheus:v3.5.0 test rules alerts.test.yml`. Live drills wait for a staging environment (P1-K.2); once it exists, run each and confirm the alert reaches its channel, then clear it:

| Alert | Drill in staging |
|---|---|
| TargetDown | Stop one worker container for 3 minutes. |
| WorkerDependencyUnavailable | Block the worker's access to Redis (or stop Redis) for 6 minutes. |
| OutboxBacklogStale | Stop all workers, place an order, wait 6 minutes. |
| QueueBacklogHigh / FailedJobsGrowing | Stop workers and queue more than 500 emails (e.g. sign-ups), or point `RESEND_API_KEY` at an invalid key so email jobs fail. |
| PaymentWebhookSignatureRejections / PaymentWebhookSettlementFailing | Post webhooks with a wrong `x-paystack-signature`; or deliver a signed `charge.success` for an unknown reference. |
| ApiInternalErrorRateHigh | Stop Postgres for 6 minutes under synthetic traffic. |
| GraphqlLatencyP95High | Add latency to the database connection (e.g. `tc netem`) under load. |
