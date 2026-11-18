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
npm run start:prod      # Run compiled output

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
npm run test:repro      # Audit repro tests (test/jest-repro.json); failures are expected until each finding is fixed

# Database
npx prisma migrate dev  # Run migrations in development (new migration: add --create-only and review the SQL first); no longer generates or seeds
npx prisma generate     # Regenerate Prisma Client (into src/generated/prisma, gitignored) after install and schema changes
npx prisma db seed      # Seed the database (command in prisma.config.ts; needs SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD)
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code  # Drift check (exit 2 = drift)
```

## Non-negotiables

These describe what the code enforces today. ADR-0004 (money), ADR-0008 (inventory) and ADR-0014 (order state machine) are still Proposed and will replace some of them.

- **Stock** changes only through logged `restock*`/`adjust*Stock` mutations or the order/cancel transactions, using conditional updates. Never write an absolute quantity. The database rejects negative stock.
- **Order status** changes only through the transition table in `src/order/order-status.ts`, applied with a conditional `updateMany` claim, never a plain update.
- **Authorization:** every resolver, and every sensitive field resolver, has an explicit policy (`@Auth`, `@Roles`, field middleware). Never expose `User` on a public type; use `PublicProfile`.
- Guards and interceptors must work in both `http` and `graphql` contexts.
- **Money:** charges are in GHS. Never do float arithmetic on money in new code; use Prisma `Decimal`.
- **Side effects** (email): never let one fail a request or vanish silently. Catch and log until the queue/outbox exists.
- No secrets or PII in logs.
- **Migrations:** create with `--create-only` and review the SQL. Never edit an applied migration. Backfills must be safe to re-run. `prisma migrate diff` must show no drift.
- **API changes:** regenerate and commit `schema.gql`. List frontend-visible changes in `STATUS.md` until `FRONTEND_API_DOCUMENTATION.md` is brought in line (P0-D.3); after that, update it with every API change.

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

Feature modules: `users`, `products`, `categories`, `sub-categories`, `brand`, `tag`, `variant`, `cart`, `order`, `payment`, `addresses`, `discount`, `coupons`, `wishlist`, `review`, `returns`, `inventory`, `analytics`, `tax`, `shipping-zones`, `pickup-locations`.

Supporting modules: `prisma` (PrismaService), `config` (Joi env validation in `env.validation.ts`, cache config), `currency`, `notifications` (Resend email + templates), `health` (health controller/indicators), plus `tracing.ts` (OpenTelemetry, enabled via `OTEL_ENABLED`).

### Authentication & Authorization (`src/iam/`)

- **JWT**: Access token (1h) + Refresh token (24h) + password-reset token (15m, `JWT_RESET_SECRET`). TTLs are overridable via `JWT_*_TTL` env vars. Refresh rotation runs in a Prisma `$transaction`. All routes are protected by default via `AuthenticationGuard`.
- Mark public routes with `@Auth(AuthType.None)`.
- Mark admin routes with `@Roles(Role.ADMIN)` or `@Roles(Role.SUPER_ADMIN)`.
- Social login: Google and Facebook via `GoogleAuthenticationService` / `FacebookAuthenticationService`, linked to users through the `AuthProvider` model.

### Commons (`src/commons/`)

- `LoggerService` — Winston-based logger, used app-wide
- `CloudinaryService` — image upload/storage (`upload.controller.ts` exposes the REST upload)
- `AuditService` — writes to the `AuditLog` model
- Global exception filter (`AllExceptionsFilter` + `error-classification.ts`) maps HTTP statuses to GraphQL codes (400 `BAD_REQUEST`, 401 `UNAUTHENTICATED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 409 `CONFLICT`; ValidationPipe failures `BAD_USER_INPUT`) and Prisma P2002/P2003 → `CONFLICT`, P2025 → `NOT_FOUND` with safe messages; stack traces are logged only in development
- GraphQL query limits (`commons/graphql/query-limits.ts`): depth ≤ 8, aliases ≤ 15, estimated cost ≤ 3000 (`graphql-query-complexity`); introspection is exempt and off in production
- `GqlThrottlerGuard` — global rate limiting (stricter limits on auth mutations such as `forgotPassword`/`resetPassword`)
- `PaginationArgs` / `PageInfo` entities are shared across all list queries

### Platform behaviour

- **Caching:** `CacheModule` is global; uses Redis when `REDIS_HOST` is set, otherwise in-memory (5 min default TTL).
- **Production safeguards:** GraphQL introspection is off when `NODE_ENV=production`; `ALLOWED_ORIGINS` is required at startup in production; helmet sets CSP and HSTS.
- **Prisma enums/models** also cover fulfillment (`FulfillmentType`, pickup locations, shipping zones), taxes, coupons/usage, return requests and inventory logs.

### Environment variables

Validated at startup by `src/config/env.validation.ts` (Joi); see `.env.example` for the full list.

```
Required:  NODE_ENV (development | test | production; no default),
           DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, JWT_RESET_SECRET (each >= 32 chars),
           JWT_TOKEN_AUDIENCE, JWT_TOKEN_ISSUER,
           GOOGLE_CLIENT_ID/SECRET, FACEBOOK_APP_ID/SECRET,
           PAYSTACK_SECRET_KEY, CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET
Production: ALLOWED_ORIGINS and REDIS_HOST are also required; placeholder secrets
           (change-me, your-..., xxx, ...) and a JWT secret reused across the three are rejected
Optional:  PORT, ALLOWED_ORIGINS, LOG_LEVEL, PAYSTACK_CALLBACK_URL,
           JWT_ACCESS_TOKEN_TTL, JWT_REFRESH_TOKEN_TTL, JWT_RESET_TOKEN_TTL,
           REDIS_HOST/PORT/PASSWORD, RESEND_API_KEY, RESEND_FROM_EMAIL,
           OTEL_ENABLED ('true' | 'false'), OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT (http(s) URI)
Seeding:   SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD
```

### Testing

Unit tests are colocated as `*.spec.ts` under `src/`. E2E tests live in `test/e2e/` (`*.e2e-spec.ts`) with shared helpers in `test/helpers/` and `test/setup.ts`; they use a separate database configured in `.env.test` (not committed — create it from `.env.test.example`; `test/setup.ts` refuses to run unless the database name ends in `_test`).
