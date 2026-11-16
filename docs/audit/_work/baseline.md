# Baseline checks — 2026-11-16

Raw outputs: `tmp/audit/baseline/*.txt`. Environment: Windows 11, Node v24.22.0, npm 11.19.1, existing `node_modules` (no `npm ci`), `git core.autocrlf=true`.

| Check | Command | Result |
|---|---|---|
| Build | `npm run build` | **Pass** (exit 0). Note: `nest build` uses `tsconfig.build.json`, which excludes specs, so spec type errors don't fail the build. |
| Typecheck (incl. specs/test) | `npx tsc --noEmit -p tsconfig.json` | **Fail** (exit 2): 5 errors — `products.service.spec.ts:77,158`, `review.service.spec.ts:27`, `users.resolver.spec.ts:103`, `test/helpers/db.helper.ts:49` (`prisma.taxRate` no longer exists → e2e helper is broken against current schema). |
| Lint | `npx eslint "{src,test}/**/*.ts"` (no `--fix`) | **Fail**: 29,488 errors; 29,487 are `prettier/prettier` "Delete `␍`" (CRLF line endings from `autocrlf=true` vs Prettier default `endOfLine: lf`) — a repo-config problem, not code. 1 real error: unused `adminToken` (no-unused-vars). |
| Format | `npx prettier --check` | **Fail**: 323 files (same CRLF cause). |
| Prisma validate | `npx prisma validate` | **Pass**. Warning: `package.json#prisma` config deprecated, removed in Prisma 7. |
| Prisma format | `npx prisma format --check` | **Fail**: schema not formatted. |
| Migration drift | `prisma migrate diff` | **Not run** — no `.env.test` / shadow DB available. Read-only comparison only. |
| Unit tests | `npx jest --coverage` | **Fail**: 14/61 suites failed, 32/554 tests failed; 18 "Test suite failed to run" (TS compile errors in specs). Failing: products (repo/resolver/service), users (service/resolver), discount (service/repo/resolver), review.service, payment (service/repo), addresses.resolver, order (service/resolver). Jest reports a worker that failed to exit (leaked handles). |
| Coverage | same | Statements 40.13%, Branches 35.06%, Functions 27.05%, Lines 39.86%. |
| E2E | `npm run test:e2e` | **Not run** — `.env.test` does not exist; `test/helpers/db.helper.ts` also fails typecheck. |
| Outdated | `npm outdated` | NestJS 10 (latest 12), `@nestjs/apollo`/`graphql` 12 (latest 14), Apollo Server 4.11 (latest 5.5; v4 EOL), Prisma 6.19 (latest 7.10), cloudinary 1.x (latest 2.x), ESLint 8 (EOL), typescript-eslint 6, Jest 29, bcrypt 5. |
| Audit | `npm audit` | Exit 1. Advisories (high + moderate) include `@apollo/server <=5.4.0`, `@nestjs/core`, `@nestjs/common <10.4.16`, `axios 1.0.0–1.19.0`, `cloudinary <2.7.0`, `jws`, `joi 18.0–18.3.0`, `body-parser`, `form-data`, `follow-redirects`, `lodash`, OpenTelemetry instrumentations. See `tmp/audit/baseline/audit.txt`. |
