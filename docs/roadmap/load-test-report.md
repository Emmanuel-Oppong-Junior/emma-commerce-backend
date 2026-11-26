# Load test report (P9-L)

Date: 2026-11-26. Scripts: `ops/loadtest/` (run with `bash ops/loadtest/run.sh`). Result: **every threshold passes at 3x the assumed peak after two fixes**. Before them the stack collapsed: 4.2% of requests failed and the p95 was 22.5 s.

## What was tested

**Target.** There is no staging yet, so the test ran against a local Docker stack (compose project `emma-load`) built from the repo's `Dockerfile`. Every service runs with `NODE_ENV=production`.

| Service | Image / version | Limits |
|---|---|---|
| API (`ROLE=api`) | repo Dockerfile, Node 24.22.1 | 2 CPUs, 1 GB |
| Worker (`ROLE=worker`) | same image | 1 CPU, 768 MB |
| Postgres | `postgres:16-alpine` (16.15), `pg_stat_statements`, `shared_buffers=512MB` | 2 CPUs, 4 GB |
| Redis | `redis:7-alpine` (7.4.12) | none |
| Paystack + Resend stub | `ops/loadtest/stubs` (Node 24), 300 ms simulated Paystack latency | none |
| k6 | `grafana/k6:1.3.0` | none |

**Machine.** Intel Core Ultra 7 255H (16 cores), 31 GB RAM, Windows 11, Docker Desktop 29.8.2 (16 CPUs and 15 GB given to the VM). Other agents ran e2e suites on the same machine during the runs, so absolute numbers are conservative. The CPU limits above are what make the API and Postgres behave like small production instances.

**Data** (`ops/loadtest/seed.ts`, idempotent, about 30 s):
- 2,000 published products and 5,999 variants (two thirds apparel with 4 sizes), each stocked at 2 locations.
- 12 categories, 36 sub-categories, 40 brands and 30 tags.
- 4 promotions: category %, brand amount off, BXGY, and a cart minimum spend.
- 2 shipping zones with STANDARD/EXPRESS rates, 4 collections and 5 homepage sections.
- 12,480 reviews.
- 1,000 customers with verified phones and an address each.
- 5 staff with a custom report-reader role (`order.view`, `report.view`, no MFA).
- 20,000 completed historical orders (40,000 lines).
- 365 days of analytics rollups (43,800 per-variant rows).

**Load profile `peak3x`.** The assumed peak is about 30 concurrent shoppers and 50 orders/hour. Three times that is 90 shoppers and 150 orders/hour. The run ramps for 2 min, holds for 10 min and ramps down for 1 min:

| Scenario | Users | What each iteration does |
|---|---|---|
| browse | 55 VUs | One of homepage or a collection page. Then a product listing with random filters (category / brand / search text, 30% price range, 30% in stock, 30% sorted) plus its facets. 40% read a second page. Then two autocomplete calls. Think time 1-3 s between steps. |
| product | 20 VUs | Product page by slug (variants, availability, prices, promotion, rating distribution), then 10 reviews. 80% of views go to the top fifth of the catalogue. Think time 2-5 s. |
| cart | 12 VUs, signed in | Cart, add to cart, cart, checkout quote (delivery). The cart is cleared at 4 lines. |
| checkout | 150 orders/hour (arrival rate) | A new sign-in, then clear the cart, add 1-3 items, quote, and `createOrder`. 30% are cash on delivery. Online orders go on to `POST /payment/initialize` (stub), then a signed `charge.success` webhook, then poll the order until it is CONFIRMED (worker path). |
| staff | 3 VUs | Order list, one order, dashboard, 30-day sales report and top products. Think time 5-10 s. |

**Rate limits are not weakened.** Each VU sends its own `X-Forwarded-For` address, which the app honours because it trusts one proxy (`main.ts`), as it would behind the production load balancer. So the production per-address limits (120 requests/min global, 5 sign-ins/min, 5 payment initialisations/min) apply unchanged to every simulated shopper. No real provider is called:
- Paystack is reached as `api.paystack.co` through compose `extra_hosts` and a throwaway CA (`NODE_EXTRA_CA_CERTS`).
- Resend is reached through its SDK's `RESEND_BASE_URL`.

**Not covered:**
- **Guest checkout.** It needs an SMS code, and SMS is refused in production mode without a provider. The codes cannot be read (they are stored only as keyed hashes).
- **Two API instances, failure injection, soak, flash-sale oversell and the webhook storm** (S3-S10 in `docs/audit/03-performance-review.md` §8). Those need staging, or are covered by e2e concurrency tests.

## Thresholds (k6 `thresholds`, the pass/fail)

| Metric | Threshold | Why |
|---|---|---|
| `http_req_failed` | < 1% | Brief; business refusals would show up as GraphQL errors in `checks`. |
| `checks` | > 99% | Every request: HTTP 200 and no GraphQL `errors`. |
| browse, product page | p95 < 300 ms, p99 < 800 ms | Server-side; Ghana mobile networks add 100-400 ms of round trip on top, so 300 ms keeps a page under about 1 s. Matches the 10x targets in the performance review §7.2. |
| cart flow, `checkoutQuote`, `createOrder` | p95 < 800 ms | Writes and a full repricing in one transaction; §7.2 asks ≤ 900 ms at 10x. |
| `POST /payment/initialize` | p95 < 1,200 ms | Includes the stub's 300 ms of simulated Paystack time. |
| Paystack webhook ack | p95 < 300 ms | Paystack retries slow acks; the work happens in the worker. |
| staff reads | p95 < 1,000 ms | Back office, few users. |
| `order_confirmed` | > 99% | An online order reaches CONFIRMED within 30 s of the webhook. |
| `order_confirm_seconds` | p95 < 10 s | From webhook to CONFIRMED (outbox → queue → worker → verify → ledger). |

## Results

| | Before (dev dc2a4d3) | After both fixes |
|---|---|---|
| Requests served | 9,883 (12.3/s) | 44,132 (56.2/s) |
| Failed requests | 4.23% | 0.00% |
| Checks passed | 97.0% | 100.0% |
| All requests p50 / p95 / p99 | 1.49 s / 22.5 s / 61 s | 29 ms / 151 ms / 338 ms |
| browse p95 / p99 | 8.94 s / 60 s | **139 ms / 274 ms** |
| product page p95 / p99 | 37.6 s / 61 s | **102 ms / 263 ms** |
| cart flow p95 | 59.6 s | **249 ms** |
| `checkoutQuote` p95 | 59.8 s | **377 ms** |
| `createOrder` p95 | 15.3 s | **719 ms** |
| `payment/initialize` p95 | 17.3 s | **467 ms** (300 ms of it is the stub) |
| webhook ack p95 | 3.46 s | **35 ms** |
| staff reads p95 | 59.5 s (order list failing) | **123 ms** |
| orders confirmed after webhook | 9 of 9 (p95 7.9 s) | 25 of 25 (p95 1.09 s) |
| Thresholds | 13 of 15 failed | all pass |

Before the fixes, the closed-loop VUs spent most of the run waiting on timeouts. That is why the before run completed only 15 orders and 9 payments, against 33 and 25 after.

### Headroom: SCALE=3 (9x the assumed peak)

The same stack at `SCALE=3` (270 VUs, 450 orders/hour) **saturates**: throughput only rose from 56 to 77 requests/s.

Latencies at 9x:

| Scenario | p95 |
|---|---|
| browse | 3.2 s |
| product page | 4.4 s |
| cart flow | 21 s |
| `checkoutQuote` | 24 s |
| `createOrder` | 6 s |
| staff reads | 3.8 s |

Other results:
- Errors were still nearly absent: 1 failed request, and 28 autocomplete P2028s (pool wait over 2 s).
- Every online order was confirmed: 64 of 64, p95 8 s.
- Postgres statement times stayed within about 2x of the 3x run (facets 60-270 ms mean, collection page 24 ms). The queueing is therefore mostly in front of the database. The most likely causes are the API's 2 CPUs and its 10-connection pool, which checkout transactions hold longest. This was not profiled further.

The knee therefore lies between 3x and 9x on a 2-CPU API. Before a promotion that could exceed about 3x, run two API instances, or measure `SCALE=2` on the production-sized instance.

## Bottlenecks found and fixes

1. **Postgres JIT compiled the catalogue statements on every execution.**
   - The facet statement (`productFacets`, `src/products/search/postgres/product-search-sql.ts`) and the search page statements are large and planned as expensive. Postgres 16 defaults to `jit=on`, so each execution spent 1-2 s compiling.
   - Measured on the idle seeded database, category + price + in-stock facets: **2,196 ms with JIT, 288 ms without**.
   - Under load the facet calls held the 10-connection pool for seconds. Everything queued behind them: product pages, carts, checkout, sign-in. `searchSuggestions`, which opens an interactive transaction, then failed with Prisma P2028 (no connection within 2 s).
   - The worst facet statement averaged 22 s and peaked at 451 s.
   - **Fix:** `PrismaService` opens every connection with `options: '-c jit=off'`. This is the usual setting for OLTP workloads; no query here benefits from JIT.
   - **Test:** `test/e2e/database-session.e2e-spec.ts` checks `current_setting('jit')` on pooled connections.
   - Note: behind PgBouncer, the startup option needs `ignore_startup_parameters = options`, or `ALTER ROLE ... SET jit = off` instead.
2. **The staff order list (`orders`) was unbounded and failed outright.**
   - With 20,000 orders it loaded every order with its lines, shipments and events. Prisma's relation queries then exceeded Postgres's bind-parameter limit: **P2029, every call failed** (8% success, otherwise about 1 s before the error).
   - **Fix:** `orders(first: Int = 20 (1-100), after: ID, status: OrderStatus)`, newest first, keyset on (`createdAt`, `id`), using the existing `Order(createdAt)` / `Order(status, createdAt)` indexes.
   - **Tests:** unit tests in `order.repository.spec.ts` / `order.service.spec.ts` / `order.resolver.spec.ts`, and `test/e2e/order-list.e2e-spec.ts` (pages, cursor, status filter, bounds).
   - Breaking change, listed in `FRONTEND_API_DOCUMENTATION.md`.

No missing index stood out, so no migration was needed. After the fixes, the hot statements in `pg_stat_statements` by total time were:
- the collection page (13.6 ms mean);
- autocomplete (8.2 ms);
- facets (30-160 ms depending on filters);
- the availability loader (2-3 ms).

The facets' cost is the aggregation itself. Their plan scans all published products and all stock levels on purpose, because every facet counts the whole catalogue.

## Follow-ups (not fixed here: bigger than a contained fix, or another lane's)

- **Facets are the most expensive read left: 30-160 ms per call, plus about 75 ms of planning.**
  - They aggregate the whole published catalogue on every listing view, computing `f_sellable` (stock at serving locations minus expired lot units) for every product, four times over.
  - Options:
    - cache them per filter for a short time (lane C, ADR-0011, already lists facet counts);
    - precompute a per-variant "sellable now" flag maintained by the ledger;
    - call facets only on the first page and when filters change (frontend guidance).
- **`userOrders` (customer) is still unbounded** and loads every order with its full include. It is fine at about 20 orders per customer, but should be paginated like `orders`.
- **`POST /payment/initialize` returns the whole order inside the attempt** (`order` with every column), which is over-fetching. Return the attempt fields and `authorizationUrl` only.
- **Connection pool:** the pg pool default is 10 per process, and the API and worker have one pool each. Set the pool size explicitly through config, and size Postgres `max_connections` for instances × pool once production topology is known (PERF-16).
- **Still to run on staging:**
  - 2 API instances behind a load balancer;
  - the flash-sale oversell check;
  - the webhook duplicate storm;
  - the failure-injection and soak scenarios of the performance review §8.

  Point the same scripts at staging with `BASE_URL`, `LOAD_USER_PASSWORD` and its test `PAYSTACK_SECRET_KEY`, after seeding it with `DATABASE_URL=... bash ops/loadtest/run.sh seed`. The seed refuses a database whose name lacks "load".

## Reproducing

```bash
bash ops/loadtest/run.sh up      # build the image, start the stack (secrets generated into tmp/loadtest/stack.env)
bash ops/loadtest/run.sh seed    # load-test data (idempotent)
bash ops/loadtest/run.sh smoke   # each scenario once
bash ops/loadtest/run.sh load    # 3x peak, 13 minutes; SCALE=3 for 9x; exit 99 when a threshold fails
bash ops/loadtest/run.sh stats   # top statements from pg_stat_statements and the stub's counters
bash ops/loadtest/run.sh down    # stop and delete the stack's volumes
```
