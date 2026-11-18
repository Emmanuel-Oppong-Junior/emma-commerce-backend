# ADR-0013 — Authorization: permission-based RBAC

Status: **Accepted** (Emmanuel, 2026-11-18) · Date: 2026-11-16

## Context
There are three hard-coded roles (`USER`, `ADMIN`, `SUPER_ADMIN`) and an exact-match `RolesGuard` with no hierarchy (SEC-03). Any ADMIN can edit or delete peer ADMINs (IAM-10/USR-03). Some operations lock SUPER_ADMIN out. The target needs owner, manager, inventory staff, pharmacist, cashier, delivery rider and support roles (prompt §3.7), scoped per store or location.

## Recommendation
- **Permissions as code constants** (`catalog.product.write`, `order.refund`, `inventory.adjust`, `rx.approve`, `user.admin.manage`, …).
- **Roles as data:** `Role(storeId, name, permissions[])` with seeded system roles (Owner, Manager, InventoryClerk, Pharmacist, Cashier, Rider, Support, Customer).
- **Assignment:** `StoreMembership(userId, storeId, roleId, locationIds?)`.
- **Guard:** `@RequirePermission('order.refund')` checks the user's permission set, cached per request, loaded with the user in `AccessTokenGuard`. Object-level checks stay in services. A policy helper (`can(user, action, resource)`) covers owner and location scoping.
- **Platform roles:** `PLATFORM_ADMIN` stays separate from store roles.
- **Sensitive actions:** these require recent authentication (step-up within the last N minutes) and are always audit-logged. They include role and permission changes, refunds, price changes, payouts and data exports.
- **MFA:** TOTP for all staff accounts, enforced for Owner and Manager.
- **Tests:** an authorization-matrix snapshot test (operation → required permission) checked in CI.

## Reversibility
Moderate. The migration maps `ADMIN` to Manager and `SUPER_ADMIN` to Owner.
