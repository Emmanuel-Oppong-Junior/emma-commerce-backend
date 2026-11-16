# Tag
Verdict: NEEDS WORK
Reviewed by: Catalogue reviewer B, Sonnet 5.5, default effort
Files reviewed: src/tag/** (module, resolver, service, repository, dto, entity, 3 specs), prisma/schema.prisma (Tag, Product.tags), src/products/products.service.ts (tag filters), src/iam/authentication/guards/roles.guard.ts

## Summary
Admin-guarded tag CRUD plus add/remove products. Reasonable structure, but tag input is validated nowhere (raw string args), uniqueness is case-sensitive and check-then-insert, bulk product attach has unhandled failure modes and no bound, and reads require login so guests cannot list tags. Specs pass (mock-based).

## Findings
| ID | Severity | Category | Description | Evidence | Confirmation | Business impact | Recommended fix |
|---|---|---|---|---|---|---|---|
| TAG-01 | Medium | Security | `createTag`/`updateTag` take `name` as a bare `@Args` String, so no class-validator rules apply. Empty, whitespace-only or very long names are accepted (column is unbounded String). | src/tag/tag.resolver.ts:29-43; prisma/schema.prisma:127 | Confirmed by reading | Garbage/blank tags; oversized rows (admin-only, so mistakes more likely than abuse). | Introduce CreateTagInput with `@IsNotEmpty @MaxLength` and trim transform. |
| TAG-02 | Medium | Data integrity | Uniqueness is case-sensitive ("Sale" vs "sale") and enforced by check-then-insert (TOCTOU). DB constraint backstops the race and create maps P2002, but `update` does not. Product search filters use `mode: 'insensitive'`, so case-variant duplicates collide in results. | src/tag/tag.service.ts:16-19,44-48,82-87; tag.repository.ts:32-41; src/products/products.service.ts:209,218 | Confirmed by reading | Duplicate tags fragment merchandising; race yields a 500. | Normalise (trim+lower or unique lower(name) index); rely on P2002 mapping in both create and update. |
| TAG-03 | Medium | Bug | `addProductsToTag` with a non-existent product id makes Prisma `connect` fail (P2025), unhandled in `connectProducts`, so the whole batch fails with a generic 500. Array is unbounded and elements are not validated (`@IsArray` only). | src/tag/tag.repository.ts:54-59; src/tag/dto/add-products-to-tag.dto.ts:11-13 | Suspected (needs verification) - not run against DB | Admin cannot tell which id is bad; huge arrays give huge queries. | Check ids exist and return a clear error; add `@ArrayMaxSize`, `@IsString({each:true})`. |
| TAG-04 | Low | Business logic | `tag` and `tags` queries require role USER/ADMIN/SUPER_ADMIN, so anonymous shoppers cannot list tags (brands are public). Guest facets could fail. | src/tag/tag.resolver.ts:14-27; roles.guard.ts:18-21 | Confirmed by reading | Possible storefront breakage for guests; may be intentional. | Decide policy; mark list/read `@Auth(AuthType.None)` if public. |
| TAG-05 | Low | Performance | `tags` is unbounded and uncached. | src/tag/tag.repository.ts:28-30 | Confirmed by reading | Minor today. | Paginate/cache if tags grow. |
| TAG-06 | Low | API design | Both product-attach mutations name their argument `updateDiscountInput` (copy-paste from discount) and removeProductsFromTag is described as "Add products to a tag". This leaks into schema.gql. Deleting a tag silently detaches all products; no audit. | src/tag/tag.resolver.ts:50-63; dto descriptions | Confirmed by reading | Confusing client contract; breaking to rename later. | Rename arg to `input` now. |
| TAG-07 | Info | Extensibility | Tag is a flat name list: no slug, type/vertical or i18n. Fine for merchandising, not for faceted attributes (pharmacy "prescription", grocery "organic", electronics specs). | prisma/schema.prisma:125-131 | Confirmed by reading | Will need a separate attribute system. | Keep tags for merchandising; plan attributes separately. |

## Test assessment
tag.service (12), tag.repository (15), tag.resolver (8) pass. All mock-based; resolver spec does not assert role metadata. No tests for case variants, blank names, unknown product ids. No e2e.

## Definition of done to close this module
- Validated Create/Update tag input DTO (TAG-01).
- Case-insensitive uniqueness, P2002 mapped on update (TAG-02).
- Product-id validation and bounds on attach (TAG-03).
- Decide public read access (TAG-04); rename misnamed args (TAG-06).
- Tests for the above plus a role-metadata/e2e test.
