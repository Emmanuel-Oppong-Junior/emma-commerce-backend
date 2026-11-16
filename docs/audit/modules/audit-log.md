# Audit log
Verdict: NEEDS WORK
Reviewed by: Admin/Analytics/Platform reviewer, Sonnet 5.5, medium
Files reviewed: src/commons/audit.service.ts, commons.module.ts, src/order/order.service.ts (all callers), grep of all AuditService usage in src/, resolvers/services for users, products, coupons, discount, tax, shipping-zones, returns, inventory, payment; prisma AuditLog model

## Summary
The only caller of AuditService in the codebase is OrderService (4 sites: status change, admin cancel, delete, shipping update). Everything else sensitive is unaudited: refunds, role/user changes, price changes, coupons, discounts, tax, shipping zones, COD payment recording, user archive/delete. Writes happen after the change, outside any transaction. The log is write-only (no query API) with no request/IP context. Inventory restocks are recorded in InventoryLog with actor (separate, adequate).

## Findings
| ID | Severity | Category | Description | Evidence | Confirmation | Business impact | Recommended fix |
|---|---|---|---|---|---|---|---|
| AUD-01 | High | Security | Refunds not audited and carry no actor. `processRefund(returnRequestId)` takes no admin id, calls Paystack, then updates status; approve/reject and the chosen refundAmount are also unaudited. Only a log line with the Paystack reference. | returns/returns.resolver.ts:34-35; returns.service.ts:63, 88-109 | Confirmed by reading | An insider can approve/refund arbitrary amounts with no attributable trail. | Pass actor id; audit approve/reject/refund (amount, reference, from/to) in the same transaction. |
| AUD-02 | High | Security | User/role changes unaudited: updateUser (can change role), removeUser, archiveUser, deArchiveUser, createUser with role. | users/users.resolver.ts:70-110; users.service.ts:24, 293 | Confirmed by reading | Privilege escalation or deletion of a customer leaves no trace. | Audit all admin user mutations with before/after role/isActive (never hashes). |
| AUD-03 | High | Security | Money-affecting configuration unaudited: product price/basePrice/isTaxable, coupon create/update/delete, discount create/update/add/remove, tax rates, shipping zones/pickup locations, COD payment recorded (log line only). | products.service.ts:29-31,114-115; coupons.resolver.ts:18-31; discount.resolver.ts:16-53; tax.resolver.ts:15-26; shipping-zones.resolver.ts; payment.service.ts:144 | Confirmed by reading | Price/coupon abuse cannot be attributed. | Audit with before/after values; centralise via interceptor/decorator on admin mutations so none are forgotten. |
| AUD-04 | Medium | Data integrity | Audit is written after the change, outside a transaction, awaited unguarded. If `auditLog.create` throws, the order change is already committed but the caller gets an error (retries); if the process dies between, the audit is lost. | order.service.ts:167-176, 206-214, 235-241, 255-262; audit.service.ts:26-34 | Confirmed by reading | Lost/inconsistent trail; confusing retries. | Accept a `tx` and write inside the same `$transaction` for money/status changes (or outbox). |
| AUD-05 | Medium | Business logic | Incomplete even in orders: customer cancelOrder, markOrderAsPaid (-> PROCESSING), system expiry of abandoned orders, and payment-webhook transitions are not audited; adminCancelOrder omits `from`. | order.service.ts:150-156, 197-203, 223-228, 206-214 | Confirmed by reading | Cannot answer who/what moved an order to PROCESSING (money dispute). | Audit system actors too (userId null + actor label). |
| AUD-06 | Medium | Data integrity | Cross-module note for order reviewer: `updateOrderStatus(..., CANCELLED)` only updates status and raises a return request, unlike adminCancelOrder it does not call cancelOrderAndRestoreStock. | order.service.ts:168-190 vs 199-215 | Confirmed by reading for this path; repository.updateStatus side effects not verified | Phantom out-of-stock. | Verify in order report; route CANCELLED through the cancel path. |
| AUD-07 | Medium | Security | No read API found, no retention policy, no request context (IP, user agent, correlation id). `details` is free JSON; today's callers store no PII but nothing prevents it. FK `userId ON DELETE SET NULL` erases the actor if a user is hard-deleted. | schema.prisma:389-401; audit.service.ts:19-34 | Confirmed by reading | Log unusable by admins; attribution lost on deletion. | Admin query with pagination/filters; store requestId/ip; deny-list sensitive keys; soft-delete users. |
| AUD-08 | Low | Tests | No audit.service spec; `AuditAction` lacks REFUND/ROLE_CHANGE; entity/action are free strings in DB. | audit.service.ts:5; schema.prisma:390-393 | Confirmed by reading | Inconsistent taxonomy. | Add spec, extend actions, enum/check constraint. |

## Test assessment
No dedicated tests. order.service suite is failing per baseline, so audit calls there are unverified.

## Definition of done to close this module
1. In-transaction audit for refunds/returns, user/role admin mutations, price/coupon/discount/tax/shipping changes, payment status changes, all order transitions incl. system actors.
2. Actor, request id, before/after stored; PII/secret deny-list.
3. Admin query API and retention.
4. Tests for AuditService and each audited mutation.
