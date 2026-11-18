# ADR-0011 — Caching and Redis

Status: **Accepted** (Emmanuel, 2026-11-18) · Date: 2026-11-16

## Context
Without `REDIS_HOST` the cache silently falls back to memory (`cache.config.ts:13-34`). Throttler storage is in memory as well, so limits are per instance and easy to bypass (PLAT-04). The category cache is dead code because the select set is never empty (PRD finding). Cache invalidation on mutations is ad hoc.

## Recommendation
- **Redis is required in production and staging.** Joi fails startup if `REDIS_HOST` is missing when `NODE_ENV=production`. The in-memory store is allowed only in development and test.
- Redis backs the cache, the throttler storage (`@nest-lab/throttler-storage-redis` or equivalent), BullMQ (ADR-0009) and distributed locks (Redlock or BullMQ repeatables).
- **What to cache:** public catalogue reads (product detail, category tree, facet counts) with key = `store:{id}:product:{id}:v{version}`. Invalidation is driven by outbox events, with no per-user data in shared keys. GraphQL responses for anonymous catalogue queries can also use HTTP caching (`Cache-Control`, CDN) through persisted queries / `GET` (ADR-0012).
- **Never cache** carts, prices with customer-specific promotions, or stock availability used for decisions.

## Reversibility
Cheap.
