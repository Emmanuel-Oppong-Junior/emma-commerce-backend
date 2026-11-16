# Health
Verdict: NEEDS WORK
Reviewed by: Admin/Analytics/Platform reviewer, Sonnet 5.5, medium
Files reviewed: src/health/health.controller.ts, health.module.ts, indicators/redis.health-indicator.ts, indicators/cloudinary.health-indicator.ts, src/app.controller.ts, app.service.ts, Dockerfile

## Summary
Endpoints are public (`@Auth(AuthType.None)`): `/health` (DB only), `/health/live` (static), `/health/ready` (DB + Redis + Cloudinary). Liveness and readiness are separated, which is good, but readiness fails the whole instance when a non-critical third party (Cloudinary) is down, and each probe makes a live Cloudinary Admin API call. No Dockerfile HEALTHCHECK. No Paystack/Resend checks (correct).

## Findings
| ID | Severity | Category | Description | Evidence | Confirmation | Business impact | Recommended fix |
|---|---|---|---|---|---|---|---|
| HLT-01 | High | Business logic | Readiness depends on Cloudinary and Redis. A failed `cloudinary.api.ping()` yields 503 from `/health/ready`, so an orchestrator pulls every replica out of rotation for an image-CDN blip that does not affect ordering. Redis is only the cache here (throttler is in-memory), yet a cache outage also fails readiness. | health.controller.ts:31-39; cloudinary.health-indicator.ts:17-25 | Behaviour Confirmed by reading; orchestrator reaction Suspected (depends on deployment) | Total outage caused by a non-critical dependency. | Readiness = DB only (and migrations applied). Put Redis/Cloudinary on a non-gating `/health/deps` for dashboards/alerts. |
| HLT-02 | Medium | Performance | Every readiness call performs a live Cloudinary Admin API ping plus a Redis set/get; frequent probes across replicas consume Cloudinary's Admin API rate quota (limit depends on plan, verify). | cloudinary.health-indicator.ts:19 | Call-per-probe Confirmed by reading; quota impact Suspected (needs verification) | Self-inflicted rate limiting of image management. | Cache result 30-60s or drop from readiness. |
| HLT-03 | Medium | Security | Unauthenticated endpoints return internal error detail on failure (`error: message` from Redis/Cloudinary exceptions, may include hostnames) and reveal the dependency stack. | redis.health-indicator.ts:30-33; cloudinary.health-indicator.ts:21-24 | Confirmed by reading | Reconnaissance aid. | Public response status-only; log details; restrict detail endpoint to internal network. |
| HLT-04 | Low | Bug | `CloudinaryHealthIndicator` calls global `cloudinary.config(...)` in its constructor (hidden global side effect duplicating CloudinaryService). Redis indicator reports healthy when REDIS_HOST unset, masking mis-configuration in prod. | cloudinary.health-indicator.ts:10-14; redis.health-indicator.ts:20-23 | Confirmed by reading | Config confusion. | Reuse CloudinaryService config; in production require REDIS_HOST or report degraded. |
| HLT-05 | Low | Business logic | `/health` is neither liveness nor readiness; no startup probe; Dockerfile has no HEALTHCHECK. | health.controller.ts:20-24; Dockerfile | Confirmed by reading | Operator ambiguity. | Keep /live and /ready only; add probes in deployment config. |
| HLT-06 | Low | Docs | `GET /` returns "Hello World!" (scaffold leftover). No health tests. | app.controller.ts:8-11; src/health has no spec | Confirmed by reading | Noise. | Remove or return version info; add indicator tests. |

## Test assessment
None for health; app.controller.spec covers only the scaffold.

## Definition of done to close this module
Readiness DB-only; deps endpoint cached/non-gating; no error detail to anonymous callers; orchestrator probes using /live and /ready; tests for indicators.
