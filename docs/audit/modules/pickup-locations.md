# Pickup Locations
Verdict: NEEDS WORK
Reviewed by: Catalogue reviewer B, Sonnet 5.5, default effort
Files reviewed: src/pickup-locations/** (no spec files exist), src/order/order.service.ts, order.module.ts, order.service.spec.ts, prisma/schema.prisma (PickupLocation, Order.pickupLocation)

## Summary
Admin CRUD is role-guarded and the public list returns only active locations. But the order flow never validates the chosen pickup location (the service method written for that is never called), the model is a bare address with no phone/hours/coordinates/instructions, and the module has no tests.

## Findings
| ID | Severity | Category | Description | Evidence | Confirmation | Business impact | Recommended fix |
|---|---|---|---|---|---|---|---|
| PCK-01 | High | Bug | `createPickupOrder` only checks `pickupLocationId` is non-empty. `PickupLocationsService.findActiveById` (checks existence and isActive) is injected but never called anywhere in src (grep: only a mock at order.service.spec.ts:23). An order can be placed for a deactivated/closed pickup location. An unknown id fails only at the FK insert (P2003, generic 500) instead of a clear 404. | src/order/order.service.ts:95-117; src/pickup-locations/pickup-locations.service.ts:37-41 | Confirmed by reading | Customers pay for pick-up at a closed branch; stock reserved for orders nobody can collect; support/refund cost. | Call `findActiveById` in createPickupOrder before building the order; add a unit test that inactive/unknown locations are rejected. **Status: Fixed in 1d33fff (P0-B.5): unknown/inactive pickup location → BadRequest before stock is touched.** |
| PCK-02 | Medium | Bug | Deleting a location that has orders hits Order FK `onDelete: Restrict` (P2003); repository maps only P2025, so admin gets a generic 500 instead of "deactivate instead". | prisma/schema.prisma:319; src/pickup-locations/pickup-locations.repository.ts:36-45 | Confirmed by reading | Admin confusion; the right action (isActive=false) is not suggested. | Catch P2003 and return Conflict with guidance, or make delete = deactivate. |
| PCK-03 | Medium | Business logic | Model fits Ghana poorly: no phone, opening hours/days, GPS coordinates, Ghana Post GPS digital address (e.g. GA-123-4567), landmark/directions, collection instructions, holiday closures, ready-time or capacity. `state` (region) and `country` are free text. | prisma/schema.prisma:522-535; entities/pickup-location.entity.ts | Confirmed by reading | Customers cannot find or call the pickup point (landmarks and phone are how addresses work in Ghana). | Add phone, digitalAddress (validated), lat/lng, landmark, hours, instructions; region as enum/reference. |
| PCK-04 | Medium | Data integrity | Pickup orders store only the FK, no snapshot (delivery orders keep `shippingAddressSnapshot`). Editing a location later rewrites history for old orders. | src/order/order.service.ts:95-117 vs 82-89; prisma/schema.prisma:318-320 | Confirmed by reading | Receipts/disputes show the wrong collection point. | Snapshot name/address/phone into the order at creation. **Status: Fixed in 1d33fff (P0-B.5): `pickupLocationSnapshot` (name, address, city, state, country) stored on the order.** |
| PCK-05 | Low | Security | Public `activePickupLocations` is intentional and returns only active rows (good) but is unpaginated/uncached. Update DTO accepts null for required fields (`@IsOptional` allows null), DTOs lack `@MaxLength`, no name uniqueness (duplicate branches possible). | src/pickup-locations/dto/*.ts; pickup-locations.repository.ts:21-23; schema:522-535 | Confirmed by reading (null-update outcome Suspected) | Minor admin-quality issues. | Length limits, null guard, optional unique (name, city). |
| PCK-06 | Low | Tests | No spec files for resolver, service or repository. | src/pickup-locations (no *.spec.ts) | Confirmed by reading | Regression risk in the pickup order path (PCK-01). | Add specs and an e2e covering an inactive location. |
| PCK-07 | Info | Extensibility | Single table with no link to inventory, courier or slots. Multi-location stock and pickup lead times need a general Location (store/warehouse/locker) shared with Inventory. | schema:522-535 | Confirmed by reading | Blocks "pick up where stock exists". | Evolve into a Location concept. |

## Test assessment
No tests for this module. The order spec mocks `findActiveById` but the service never uses it, so nothing would catch PCK-01.

## Definition of done to close this module
- Order flow validates location is active (PCK-01), with tests.
- Delete conflict handling or deactivate-only (PCK-02).
- Ghana-appropriate fields (PCK-03) and order snapshot (PCK-04).
- Input hardening (PCK-05); spec files and e2e (PCK-06).
