# Audit repro tests

Each test asserts the correct business behaviour and fails on the current code, proving a finding from `docs/audit/`. They must turn green when the finding is fixed. No database is needed: services are built with stubbed repositories.

Run: `npx jest --config test/jest-repro.json`

| File | Findings |
|---|---|
| `order-lifecycle.repro-spec.ts` | ORD-01 repeat cancel restores stock, ORD-03 delete restores stock for delivered order, ORD-04 any status transition allowed |
| `payment.repro-spec.ts` | PAY-01 verify revives DELIVERED/CANCELLED order, PAY-05 amount not checked, PAY-02 pay for cancelled order, PAY-03 pending attempt deleted on retry |
| `discount.repro-spec.ts` | DISC-01 `finalizeOrder` rewrites total (any status, drops shipping), DISC-02 best-discount picker compares raw values |
| `platform.repro-spec.ts` | PLAT-01 logging interceptor breaks every REST route, IAM-07 guards break REST auth, PLAT-02 tokens logged in clear, IAM-05 sign-in rejects >16-char passwords, SHZ-01 unmatched city ships free |
| `field-resolver-auth.repro-spec.ts` | SEC-01 field resolvers skip guards → other customers' addresses readable |
