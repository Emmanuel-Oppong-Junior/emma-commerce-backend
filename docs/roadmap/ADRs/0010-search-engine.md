# ADR-0010 — Search engine

Status: **Accepted** (Emmanuel, 2026-11-18) · Date: 2026-11-16

## Context
Search is Prisma `fullTextSearchPostgres` with raw user text passed to `to_tsquery`, which likely fails on special characters (suspected). There is no GIN index. Several filters are broken: `inStock` is always true, `priceMin` and `priceMax` overwrite each other, and `subCategoryName` is compared against the category name (PRD findings). The target needs typo tolerance, attribute-driven facets, synonyms and autocomplete.

## Options
| | Postgres FTS + `pg_trgm` | Meilisearch | Typesense | OpenSearch |
|---|---|---|---|---|
| Ops | None extra | 1 small service | 1 small service | Heavy (JVM, cluster) |
| Typo tolerance / autocomplete | Trigram, manual | Built in | Built in | Configurable |
| Facets | Manual SQL | Built in | Built in | Built in |
| Consistency | Transactional | Async indexing | Async indexing | Async indexing |
| Cost at SME scale | Lowest | Low | Low | High |

## Recommendation
Put a `SearchPort` behind the products module now. Implement it first with **Postgres** (`websearch_to_tsquery`, generated `tsvector` with weights, a GIN index, and `pg_trgm` for fuzzy name matching). Add **Meilisearch** as a second adapter when attribute facets and typo tolerance become product requirements (Phase 6). The outbox drives indexing (ADR-0009). Typesense is an equal alternative to Meilisearch; OpenSearch is overkill.

## Reversibility
Cheap, thanks to the port.
