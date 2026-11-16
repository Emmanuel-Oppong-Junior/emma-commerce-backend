# Wishlist
Verdict: NEEDS WORK (small, safe module; a few validation and API gaps)
Reviewed by: Customer-Features reviewer, Claude Sonnet 5.5, default effort
Files reviewed: `src/wishlist/**` (resolver, service, repository, entity, module, 3 specs), `prisma/schema.prisma` (WishList, implicit m:n with Product), `schema.gql`, `test/e2e/wishlist.e2e-spec.ts` (names).

## Summary
Every operation is keyed on the caller's own `userId` (no wishlist id is accepted from the client), so there is no cross-user access. Product existence is checked but status is not: inactive, draft and archived products can be wished and are returned in full with their fields. The wishlist is read-modify-write (create-on-read, in-memory duplicate/limit checks), the `Wishlist.user` field is declared non-null with no resolver, and nothing flags wished products that became unavailable or changed price.

## Findings
| ID | Severity | Category | Description | Evidence (file:line) | Confirmation | Business impact | Recommended fix |
|---|---|---|---|---|---|---|---|
| WSH-01 | Medium | Business logic | `addToWishlist` only checks that the product exists (`findUnique` by id). Inactive, `DRAFT` and `ARCHIVED` products can be added and are returned through `Wishlist.products` with all product fields (price, stock `quantity`, etc.). Products deactivated later also stay in the list with no availability flag. | `src/wishlist/wishlist.service.ts:25-31,55-60`; `src/wishlist/wishlist.repository.ts:25-27,72-76` (`include: { products: true }`); `prisma/schema.prisma:155-200` | Confirmed by reading | Unpublished product details exposed to anyone who guesses an id; customers wish items they can never buy; stale UX. | Require published and active at add time; on read return an `isAvailable` flag or filter unavailable items with a count. |
| WSH-02 | Low | Concurrency | `getOrCreateWishlist` is find-then-create on a `userId @unique` table: two concurrent first requests (e.g. two tabs) make the second `create` throw P2002, unmapped, so the client gets "Internal server error". The 100-item limit and duplicate check use a stale in-memory copy; implicit m:n `connect` is idempotent so no duplicate rows result, only a misleading "already in wishlist"/limit race. | `src/wishlist/wishlist.service.ts:14-17,25-31,67-70`; `src/wishlist/wishlist.repository.ts:18-23` | Confirmed by reading | Rare first-use error; harmless limit overshoot. | `upsert` on `userId`. |
| WSH-03 | Low | API design | `Wishlist.user` is declared as non-null `User!` but no resolver or repository `include` supplies it; selecting `user` fails with a non-null error. `wishlist` (a query) creates a row as a side effect (a query that writes). `addToWishlist` on an existing item throws BadRequest instead of being idempotent; `removeFromWishlist` of a missing item throws NotFound. | `src/wishlist/entities/wishlist.entity.ts:13-14`; `src/wishlist/wishlist.resolver.ts:17-19`; `src/wishlist/wishlist.service.ts:14-17,66-80` | Confirmed by reading | Client errors for harmless repeats; a trap field. | Remove `user` from the entity (or resolve it with an ownership check, see USR-01); make add/remove idempotent; read without writing. |
| WSH-04 | Low | Performance | Wishlist returns whole `Product` rows (full descriptions, images, attachments) for up to 100 items per request, unpaginated. | `src/wishlist/wishlist.repository.ts:11-16,72-76` | Confirmed by reading | Heavy payloads on mobile networks. | Select needed fields or paginate. |
| WSH-05 | Info | Business logic | Missing features expected for conversion: move-to-cart, price-drop / back-in-stock notification (no notification path exists for it), shared wishlists. Not defects. | n/a | Confirmed by reading | Lost re-engagement revenue. | Backlog. |
| WSH-06 | Low | Tests | Unit specs pass but mock the repository; none covers inactive/draft products, concurrent creation, limit boundary at the DB, or the e2e path (e2e suite cannot run: no `.env.test`; baseline). | `src/wishlist/*.spec.ts`; `test/e2e/wishlist.e2e-spec.ts` | Confirmed by test (3 suites pass) | Gaps above are invisible. | Add the cases. |

## Positives (checked, no defect)
- No client-supplied wishlist id anywhere; `userId` comes from `@ActiveUser('id')` for all four operations, so user A cannot read or change user B's wishlist.
- Limit of 100 and duplicate check exist; deleting a user cascades the wishlist.

## Test assessment
Resolver (105), service (159), repository (185) specs pass. Mock-heavy, happy-path leaning.

## Definition of done to close this module
1. Only purchasable products can be added; unavailable items are flagged on read (WSH-01).
2. `upsert`-based creation, idempotent add/remove, read without side effect (WSH-02/03).
3. Remove or correctly resolve `Wishlist.user` (WSH-03).
4. Tests for the above and an e2e run once the e2e environment exists (WSH-06).
