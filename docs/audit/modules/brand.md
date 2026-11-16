# Brand
Verdict: NEEDS WORK
Reviewed by: Catalogue reviewer B, Sonnet 5.5, default effort
Files reviewed: src/brand/** (module, resolver, service, repository, dto, entity, 4 specs), prisma/schema.prisma (Brand, Product.brand), src/commons/useful-functions.ts, src/commons/filters/all-exceptions.filter.ts

## Summary
Small, guarded CRUD. Admin mutations are role-protected; reads are public. Main gaps: unbounded public list, a public nested `products` selection that bypasses any product filtering, case-sensitive uniqueness, null-on-required update crashes, and deleting a brand silently detaches products. Unit specs pass (`npx jest src/brand src/tag`: 6 suites, 58 tests) but are all mock-based.

## Findings
| ID | Severity | Category | Description | Evidence | Confirmation | Business impact | Recommended fix |
|---|---|---|---|---|---|---|---|
| BRD-01 | Medium | Security | Public `brands` query builds a Prisma `select` from the GraphQL selection (level 1, nothing excluded). A client can request `brands { products { ... } }` and get every product of every brand with no pagination and no active/published/stock filtering applied. | src/brand/brand.resolver.ts:41-48; src/commons/useful-functions.ts:98-117; src/brand/brand.service.ts:47-53 | Confirmed by reading | Unauthenticated bulk scrape of the catalogue; draft/inactive products may leak; heavy unbounded query (DoS lever). | Drop the generic select for relations; add a `@ResolveField products` that goes through the products service with pagination and public filters, or exclude `products` from the select. |
| BRD-02 | Medium | Performance | `brands` is unbounded: no pagination, no cache, though the repo has a global CacheModule. | src/brand/brand.service.ts:47-53; brand.resolver.ts:41-49 | Confirmed by reading | Fine for dozens of brands; grows linearly for a multi-vertical marketplace; every storefront page load hits DB. | Add PaginationArgs (project convention) and/or cache the list with invalidation on mutation. |
| BRD-03 | Medium | Data integrity | Brand name uniqueness is case-sensitive (`name @unique`), so "Nike" and "nike" coexist. DTO does not trim. | prisma/schema.prisma:117; src/brand/dto/create-brand.input.ts:6-10 | Confirmed by reading | Duplicate brands split product listings and filters. | Trim in DTO; add case-insensitive unique index (lower(name)) or a normalised slug column. |
| BRD-04 | Medium | Bug | UpdateBrandInput is PartialType(Create) with nullable GraphQL fields; `@IsOptional()` accepts `null`, so `updateBrand(input:{name:null})` passes validation and reaches Prisma on a required column, giving an opaque INTERNAL_SERVER_ERROR. | src/brand/dto/update-brand.input.ts:5; brand.service.ts:27-30; brand.repository.ts:20-29 | Suspected (needs verification) - not run against DB | Admin gets opaque 500; no data harm. | Reject null for required fields (`@ValidateIf(v => v.name !== undefined)`). |
| BRD-05 | Medium | Data integrity | Deleting a brand with products: Product.brand is optional with default referential action (SetNull), so products silently lose their brand; no guard, no confirmation, no audit log. | prisma/schema.prisma:200-201; brand.service.ts:61-64 | Confirmed by reading (Prisma default for optional relation is SetNull) | Catalogue silently degrades; brand pages empty; association unrecoverable. | Block delete when products exist (or require a force flag); write an AuditLog row. |
| BRD-06 | Low | Bug | Rename collision: repository.update handles only P2025, not P2002, so a duplicate name on update becomes a generic 500 (create handles P2002 correctly). | src/brand/brand.repository.ts:20-29 | Confirmed by reading | Poor admin UX. | Map P2002 to ConflictException in update. |
| BRD-07 | Low | Security | `logo` accepts any https URL (no host allow-list e.g. Cloudinary); `description` has no max length. | src/brand/dto/create-brand.input.ts:12-20 | Confirmed by reading | Hotlinked/tracking images, oversized payloads. | Restrict to the Cloudinary host or an upload id; add `@MaxLength` to description. |
| BRD-08 | Low | API design | `brand(id)` returns null for a missing id while its docstring says it throws NotFound; `id` args are untyped strings (not ID); no AuditService use on admin mutations. | src/brand/brand.service.ts:32-40; brand.resolver.ts:25,31,37 | Confirmed by reading | Inconsistent client behaviour; no accountability for catalogue edits. | Align contract; use ID type; call AuditService. |
| BRD-09 | Info | Docs | CLAUDE.md says the global exception filter "handles Prisma errors and maps them to GraphQL errors". The filter has no Prisma handling; unmapped Prisma errors surface as generic 500. Applies to all four modules here. | src/commons/filters/all-exceptions.filter.ts:11-30 | Confirmed by reading | Misleads maintainers into skipping per-repo error mapping. | Fix docs or add P2002/P2003/P2025 mapping. |

## Test assessment
brand.service.spec (9 tests) and brand.repository.spec (13 tests) pass and cover happy paths plus P2002/P2025 mapping with mocked Prisma. brand.resolver.spec is a single "should be defined" test with an empty service mock, so role guards, the public/admin split and the nested select are untested. No e2e. Nothing tests delete-with-products, case-variant names or null updates.

## Definition of done to close this module
- Public `brands` paginated (and cacheable); nested `products` no longer selectable unfiltered (BRD-01, 02).
- Case-insensitive uniqueness plus trimming (BRD-03).
- Null-safe update, P2002 mapped on update (BRD-04, 06).
- Delete policy for brands with products plus audit entry (BRD-05, 08).
- Resolver tests asserting roles/public access; e2e for create/duplicate/delete.
