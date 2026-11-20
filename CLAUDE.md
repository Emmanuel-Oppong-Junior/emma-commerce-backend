# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

NestJS 12 + Apollo GraphQL (code-first) + Prisma/PostgreSQL e-commerce backend, Ghana-first (GHS, Paystack, MoMo, COD).

## Working state (read first)

Work follows a phased roadmap. **[`docs/roadmap/STATUS.md`](docs/roadmap/STATUS.md) is the live state of the work.** It holds the current phase, the active task and its exact next step, what's next, blockers and decisions. A session can be deleted at any moment, so never rely on "updating at the end": keep `STATUS.md` current **while** you work.

| File | Purpose |
|---|---|
| [`docs/roadmap/STATUS.md`](docs/roadmap/STATUS.md) | **Where we are and what to do next.** Single source of truth for progress. |
| [`docs/roadmap/ROADMAP.md`](docs/roadmap/ROADMAP.md) | The plan: phases, epics, tasks (`P<phase>-<epic>.<n>`), acceptance criteria, as a checklist with a Progress table: the at-a-glance view of what is done, in progress and to do. Detail stays in `STATUS.md`. |
| [`docs/roadmap/WORKING-AGREEMENT.md`](docs/roadmap/WORKING-AGREEMENT.md) | Branching, definition of done, safety rails |
| [`docs/roadmap/ADRs/`](docs/roadmap/ADRs/README.md) | Architecture decisions. Implement only **Accepted** ones. |
| [`docs/audit/`](docs/audit/SUMMARY.md) | Audit findings by ID. `docs/audit/modules/<module>.md` lists each module's open defects and definition of done. |

**Resuming ("continue", or any new session):**
1. Read `STATUS.md`. If there is an **Active task**, its **Next step** is where to pick up. Otherwise take the first **Up next** task whose blockers are clear.
2. Check it against reality, because the last checkpoint may be one step behind. Run `git branch --show-current`, `git status --short` and `git log --oneline -5`. If git shows work that `STATUS.md` doesn't mention (uncommitted files, newer commits), work out what was done, update `STATUS.md` first, then continue.
3. Read the task's entry in `ROADMAP.md`, the ADRs it links, and the module report(s) for the code it touches.
4. Tell the user which task and step you are resuming and your plan. Wait for go-ahead on multi-file or design changes.
5. If the task needs something listed under "Waiting on Emmanuel", ask instead of guessing.

**Checkpoint: update `STATUS.md` immediately whenever any of these happens:**
- **Starting a task:** set the Active task, branch, state, and a step checklist with the **Next step** marked. In `ROADMAP.md`, mark the task `- [ ] 🔄`.
- **Finishing a step:** tick it, note the files touched or the commit, and move the **Next step** marker.
- **Running tests:** record the command and the result under "Last test run".
- **Committing:** record the hash on the step.
- **Getting blocked, or making or receiving a decision:** add it to "Waiting on Emmanuel" or "Decisions log".
- **Completing a task:**
  - Clear the Active task.
  - Update the epic progress counts and the repro-test count.
  - Move the task off "Up next".
  - In `ROADMAP.md`, tick the task (`- [x]`, commit hash in brackets), add `✅ complete` to its epic heading when every task is ticked, and update the Progress table counts.
  - In each fixed finding's module report, mark the finding `Fixed in <commit>`, and change the verdict if the module's definition of done is met.

Make each checkpoint a small edit to `STATUS.md` in the same turn as the work, never batched for later. Before starting a long-running command, make sure `STATUS.md` already says what you are about to do.

**Scratch files:** put any file that should not be in git in `tmp/` (it is gitignored). That covers notes, raw tool output, experiments and exports. Never leave scratch files elsewhere in the repo.

## Commands

```bash
# Development
npm run start:dev       # Start with live reload (development)
npm run start:debug     # Start with debugger and watch
npm run start:prod      # Run compiled output (ROLE=api by default)
npm run start:worker    # Run the compiled worker (same as ROLE=worker node dist/main)

# Build
npm run build           # Compile TypeScript via NestJS CLI

# Code quality (the check-only variants are what CI runs)
npm run typecheck       # tsc --noEmit incl. specs (npm run build excludes specs, so don't rely on it)
npm run lint:check      # ESLint, no fixes
npm run format:check    # Prettier check (src, test)
npm run lint            # ESLint with auto-fix
npm run format          # Prettier format

# Testing
npm run test            # Run all unit tests (always via the npm scripts: Jest needs --experimental-vm-modules to load the ESM-only Nest 12 packages, so bare `npx jest` fails)
npm run test:watch      # Watch mode
npm run test:cov        # Coverage report
npm run test:e2e        # End-to-end tests (test/jest-e2e.json, runs in band, separate .env.test DB)
bash scripts/e2e/run.sh <db>_test <redis-db> [filters]  # e2e in Linux against the local emma-e2e-pg/emma-e2e-redis containers (cached node_modules)
npm run test:repro      # Audit repro tests (test/jest-repro.json); failures are expected until each finding is fixed

# Database
npx prisma migrate dev  # Run migrations in development (new migration: add --create-only and review the SQL first); no longer generates or seeds
npx prisma generate     # Regenerate Prisma Client (into src/generated/prisma, gitignored) after install and schema changes
npx prisma db seed      # Seed the database (command in prisma.config.ts; needs SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD)
npm run schema:generate # Rewrite schema.gql from the resolvers (no DB or env needed)
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code  # Drift check (exit 2 = drift)
psql "$DATABASE_URL" -f scripts/reports/variant-migration-report.sql  # What the P1-V.2 variant migration could not map (read-only)
```

## Non-negotiables

These describe what the code enforces today. ADR-0004 (money), ADR-0008 (inventory) and ADR-0014 (order state machine) are still Proposed and will replace some of them.

- **Variant = SKU (ADR-0003):** price, stock, SKU and barcode live on `Variant`; every product has at least one (a default variant without options). Carts, orders and inventory logs reference `variantId`. Product attributes and variant option values are checked by the pure `src/product-types/domain/attribute-validation.ts` against the product type.
- **Stock** changes only through the logged `restockVariant`/`adjustVariantStock` mutations, a variant's initial stock at creation (logged) or the order/cancel transactions, using conditional updates. Never write an absolute quantity. The database rejects negative stock.
- **Order status** changes only through the transition table in `src/order/order-status.ts`, applied with a conditional `updateMany` claim, never a plain update.
- **Authorization:** every resolver, and every sensitive field resolver, has an explicit policy (`@Auth`, `@RequirePermission`, `@CustomerOnly`, field middleware). Permissions are code constants in `src/iam/authorization/permissions.ts`; never check `User.role` (deprecated, kept in step for old clients). `src/iam/authorization/auth-matrix.spec.ts` snapshots every operation's policy and fails on an operation without one; after a deliberate policy change review the diff and accept it with `npm test -- -u auth-matrix`. Never expose `User` on a public type; use `PublicProfile`.
- Guards and interceptors must work in both `http` and `graphql` contexts.
- **Money:** charges are in GHS. Never do float arithmetic on money in new code; use Prisma `Decimal`.
- **Side effects** (email, webhook processing) run in the worker, never on the request path. After a state change, write an outbox event in the same transaction (`OutboxService.record(tx, ...)`); for an email with no surrounding transaction, use `NotificationsService` (it queues the job). Consumers are idempotent on the job id; errors and logs carry no addresses or tokens.
- No secrets or PII in logs.
- **Migrations:** create with `--create-only` and review the SQL. Never edit an applied migration. Backfills must be safe to re-run. `prisma migrate diff` must show no drift.
- **API changes:** regenerate `schema.gql` with `npm run schema:generate` and commit it (CI fails on a stale file). Update `FRONTEND_API_DOCUMENTATION.md` with every API change. CI's graphql-inspector check fails on breaking changes unless a commit in the push/PR is marked `[breaking-api]`.
- **No API clients yet (Emmanuel, 2026-11-20):** no frontend or other client uses this API, so breaking changes are allowed without deprecation windows or compatibility shims: choose the clean design. Still mark such commits `[breaking-api]` and list the breaks in `FRONTEND_API_DOCUMENTATION.md`. This ends when the first frontend or client integrates; from then on, deprecate before removing.

## Architecture

**NestJS** backend with **GraphQL** (Apollo Server v5, Express 5) as the primary API. REST endpoints exist only for payment webhooks (Paystack). The GraphQL schema is auto-generated to `schema.gql` on startup.

**Database:** PostgreSQL via **Prisma 7** ORM with the `@prisma/adapter-pg` driver adapter. Schema lives in `prisma/schema.prisma`; CLI config (schema and migrations paths, seed command, `DATABASE_URL`) in `prisma.config.ts`, which loads `.env` itself. Import the client, `Prisma` and enums from `src/generated/prisma/client`, not `@prisma/client`. Migrations are in `prisma/migrations/`.

### Module structure

Each feature follows this pattern:
```
feature/
├── feature.module.ts
├── feature.service.ts        # Business logic, calls Prisma directly
├── feature.resolver.ts       # GraphQL queries/mutations
├── dto/                      # Input types and filter args (class-validator decorated)
├── entities/                 # GraphQL output types
└── enums/                    # Feature-specific enums
```

Feature modules: `users`, `products`, `product-types`, `categories`, `sub-categories`, `brand`, `tag`, `variant`, `cart`, `order`, `payment`, `addresses`, `discount`, `coupons`, `wishlist`, `review`, `returns`, `inventory`, `analytics`, `tax`, `shipping-zones`, `pickup-locations`.

Supporting modules: `prisma` (PrismaService), `config` (Joi env validation in `env.validation.ts`, cache config), `currency`, `notifications` (Resend email + templates), `health` (health controller/indicators), `redis` (shared ioredis client), `jobs` (BullMQ queues), `outbox` (domain events + relay), `worker` (the `ROLE=worker` root module), plus `instrument.ts` (main.ts's first import: starts Sentry, then `telemetry.ts`: one OpenTelemetry NodeSDK for traces, enabled via `OTEL_ENABLED`, and Prometheus metrics) and `observability/` (Sentry options and PII scrubbing, `reportError`/`reportFailedJob`, `AppMetrics`, the HTTP metrics middleware and the GraphQL metrics plugin).

### Authentication & Authorization (`src/iam/`)

- **JWT**: Access token (1h) + Refresh token (24h) + password-reset token (15m, `JWT_RESET_SECRET`). TTLs are overridable via `JWT_*_TTL` env vars. Refresh rotation runs in a Prisma `$transaction`. All routes are protected by default via `AuthenticationGuard`.
- Mark public routes with `@Auth(AuthType.None)`.
- Mark staff routes with `@RequirePermission('order.refund', ...)` (ADR-0013) and customer self-service routes staff must not use with `@CustomerOnly()`. Mark routes open to any signed-in user with `@Auth(AuthType.Bearer)`.
- Roles are data: `StaffRole` (system roles Owner, Manager, InventoryClerk, Cashier, Support seeded by migration; Owner always holds every permission) assigned through one `StoreMembership` per user. `AccessTokenGuard` loads the membership with the user on every request (`request.access`, `@ActiveAccess()`); `AuthorizationGuard` enforces the policy. Staff-account and role changes follow `src/iam/authorization/staff-rules.ts` (no escalation, only an Owner acts on an Owner, the last Owner stays) and are audited.
- Social login: Google and Facebook via `GoogleAuthenticationService` / `FacebookAuthenticationService`, linked to users through the `AuthProvider` model.
- **MFA (`src/iam/mfa/`):** own RFC 6238 TOTP on `node:crypto` (SHA1, 6 digits, 30 s, ±1 step, replayed steps refused via `User.mfaLastUsedStep`); secrets AES-256-GCM encrypted with `MFA_ENCRYPTION_KEY` (user id as AAD), 10 single-use recovery codes stored as keyed hashes. `AuthenticationService.generateTokens` is the only way to start a session after a first factor and fails with `UNAUTHENTICATED` + `reason: MFA_REQUIRED` + a 5-minute `mfaChallenge` for MFA users (so password and social sign-in cannot skip it); `completeMfaSignIn` finishes it. Roles with `mfaRequired` (Owner, Manager) get `FORBIDDEN` + `reason: MFA_ENROLLMENT_REQUIRED` on every permission-guarded operation until enrolled.
- **Step-up:** mark sensitive resolvers `@RequireStepUp()` (optionally with an argument condition) next to `@RequirePermission`. Access tokens carry a session id (`sid`, kept across refresh); `stepUp`, `completeMfaSignIn` and `confirmMfaEnrollment` record a verification per session in Redis (`StepUpStore`, 10 minutes); otherwise `FORBIDDEN` + `reason: STEP_UP_REQUIRED`. Covered: role/permission changes, refunds, price changes (product/variant price, discounts, coupons, taxes), data exports (`addresses` without `userId`).
- e2e helpers: `prepareStaffAccounts` gives directly inserted ADMIN/SUPER_ADMIN users their membership and enrols Owner/Manager MFA with `TEST_TOTP_SEED`; `signInWithPassword` completes the second factor (fresh step-up).

### Commons (`src/commons/`)

- `LoggerService` — Winston-based logger, used app-wide: single-line JSON on stdout (ISO UTC `timestamp`, `level`, `message`, `context`, `requestId`, `userId`, `jobId`/`queue` in jobs, plus structured fields passed as the third argument); coloured text and rotated files under `logs/` in development only. Level via `LOG_LEVEL`. Stack traces only in development (`stackForLog`)
- `CloudinaryService` — image upload/storage (`upload.controller.ts` exposes the REST upload)
- `AuditService` — writes to the `AuditLog` model
- Global exception filter (`AllExceptionsFilter` + `error-classification.ts`) maps HTTP statuses to GraphQL codes (400 `BAD_REQUEST`, 401 `UNAUTHENTICATED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 409 `CONFLICT`; ValidationPipe failures `BAD_USER_INPUT`) and Prisma P2002/P2003 → `CONFLICT`, P2025 → `NOT_FOUND` with safe messages; an HttpException whose response has `extensions` (e.g. `reason`) passes them on; stack traces are logged only in development
- GraphQL query limits (`commons/graphql/query-limits.ts`): depth ≤ 8, aliases ≤ 15, estimated cost ≤ 3000 (`graphql-query-complexity`); introspection is exempt and off in production
- `GqlThrottlerGuard` — global rate limiting (stricter limits on auth mutations such as `forgotPassword`/`resetPassword`)
- `PaginationArgs` / `PageInfo` entities are shared across all list queries

### Platform behaviour

- **Redis is required** in every environment (`REDIS_HOST`; startup fails without it). It backs the global `CacheModule` (5 min default TTL), the throttler storage (`RedisThrottlerStorage`, one Lua script, so limits hold across instances) and the shared ioredis client (`REDIS_CLIENT` from `src/redis/redis.module.ts`, closed on shutdown). `/health/ready` probes it with `PING`.
- **Two processes, one image:** `ROLE=api` (default) serves GraphQL/REST; `ROLE=worker` (`src/worker/worker.module.ts`, or `--role=worker`) runs the outbox relay and the BullMQ processors and serves only `GET /health/live` and `/health/ready` on `PORT`. Queue processors are registered only in `WorkerModule`, so the API never consumes jobs. Both shut down gracefully on SIGTERM.
- **Repeatable jobs:** the former crons are BullMQ job schedulers on the `maintenance` queue (`src/worker/maintenance-jobs.ts`), upserted by every worker at startup and run once per tick across the cluster; the tasks keep their Postgres advisory locks as a second guard. There is no `@nestjs/schedule`.
- **Queues:** `notifications` (outbox email events and direct email jobs; 6 attempts, exponential backoff from 5 s; sent-once marker per job id in Redis plus Resend idempotency key), `webhooks` (stored Paystack events, job id = `WebhookEvent` id; 8 attempts; the endpoint answers 200 once the event is stored), `maintenance` (repeatable jobs). Jobs that spend their attempts stay in the failed set (30 days) and are listed/retried by the SUPER_ADMIN `failedJobs` / `retryFailedJob` operations (audited).
- **Outbox (ADR-0009):** write a domain event with `OutboxService.record(tx, event)` inside the business transaction; event types are versioned (`src/outbox/domain-events.ts`). The worker's `OutboxRelay` publishes unpublished rows (`FOR UPDATE SKIP LOCKED`) to BullMQ with `jobId = event id`; consumers must be idempotent on that id.
- **Production safeguards:** GraphQL introspection is off when `NODE_ENV=production`; `ALLOWED_ORIGINS` is required at startup in production; helmet sets CSP and HSTS.
- **Correlation:** `LoggerMiddleware` keeps a client `X-Request-ID` matching `^[A-Za-z0-9-]{1,64}$` (else generates a UUID), echoes it in the response and runs the request inside an `AsyncLocalStorage` context (`src/commons/correlation.ts`), so every log record carries `requestId` (and `userId` once authenticated) without passing it around. Jobs carry it as `meta.requestId` in their data (`withJobMeta`; outbox rows store it in `OutboxEvent.requestId` and the relay copies it); processors run each job inside `runJobInContext` (requestId + jobId + queue; scheduled jobs get a fresh id).
- **Error tracking (Sentry):** on only when `SENTRY_DSN` is set, in both roles, initialised before the app. Reported: 5xx/`INTERNAL_SERVER_ERROR` from REST and GraphQL (`AllExceptionsFilter`, and `formatError` for errors the filter never saw), and BullMQ jobs with no attempts left; expected client errors (4xx, `BAD_USER_INPUT`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`) are not. Events carry `requestId`/`jobId`/`queue` tags and the user id only; `dataCollection` is all off and `scrubEvent` strips request bodies, headers, cookies, query strings and breadcrumbs. Use `reportError(exception)` for a caught server failure that must not vanish.
- **Metrics (Prometheus):** unless `METRICS_ENABLED=false`, each process serves `GET /metrics` from the OpenTelemetry Prometheus exporter's own server on `METRICS_PORT` (default 9464, all interfaces; never the API port, so do not expose it publicly). API: `http_request_duration_seconds` (method, route template, status class), `graphql_operation_duration_seconds` (operation name capped at 100 distinct names, type, outcome), `api_errors_total` (transport, code), `webhook_processing_failures_total`. Worker: `job_duration_seconds`/`job_failures_total` (queue, name), `queue_jobs` (queue, state), `outbox_unpublished_events`, `outbox_oldest_unpublished_age_seconds`, `payment_reconciliation_mismatches_total`. Record through `AppMetrics` (global `ObservabilityModule`); labels must stay bounded (no ids, raw paths or variable values). Alert rules: `ops/prometheus/alerts.yml` (drills in `alerts.test.yml`; see `docs/roadmap/environments.md` → Observability). A port clash fails startup; the API and worker need different ports when they share a network namespace.
- **Prisma enums/models** also cover fulfillment (`FulfillmentType`, pickup locations, shipping zones), taxes, coupons/usage, return requests and inventory logs.

### Environment variables

Validated at startup by `src/config/env.validation.ts` (Joi); see `.env.example` for the full list.

```
Required:  NODE_ENV (development | test | production; no default),
           DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, JWT_RESET_SECRET (each >= 32 chars),
           JWT_TOKEN_AUDIENCE, JWT_TOKEN_ISSUER,
           GOOGLE_CLIENT_ID/SECRET, FACEBOOK_APP_ID/SECRET,
           PAYSTACK_SECRET_KEY, CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET,
           REDIS_HOST (every environment),
           MFA_ENCRYPTION_KEY (64 hex chars = 32 bytes; encrypts TOTP secrets, keys recovery-code hashes)
Production: ALLOWED_ORIGINS is also required; placeholder secrets
           (change-me, your-..., xxx, ..., an MFA key made of a repeated pattern) and a JWT secret reused across
           the three are rejected
Optional:  PORT, ROLE (api | worker, default api), ALLOWED_ORIGINS, LOG_LEVEL, PAYSTACK_CALLBACK_URL,
           JWT_ACCESS_TOKEN_TTL, JWT_REFRESH_TOKEN_TTL, JWT_RESET_TOKEN_TTL,
           REDIS_PORT (6379), REDIS_PASSWORD, REDIS_DB (0-15, default 0), RESEND_API_KEY, RESEND_FROM_EMAIL,
           OTEL_ENABLED ('true' | 'false'), OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT (http(s) URI),
           SENTRY_DSN (http(s) URI; Sentry is off when unset), SENTRY_ENVIRONMENT (default NODE_ENV),
           SENTRY_RELEASE, SENTRY_TRACES_SAMPLE_RATE (0-1, default 0),
           METRICS_ENABLED ('true' | 'false', default 'true'), METRICS_PORT (default 9464)
Seeding:   SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD
```

### Testing

Unit tests are colocated as `*.spec.ts` under `src/`. E2E tests live in `test/e2e/` (`*.e2e-spec.ts`) with shared helpers in `test/helpers/` and `test/setup.ts`; they use a separate database and Redis configured in `.env.test` (not committed — create it from `.env.test.example` or with `node scripts/write-test-env.js <DATABASE_URL> [redis://host:port/db]`; `test/setup.ts` refuses to run unless the database name ends in `_test`).
