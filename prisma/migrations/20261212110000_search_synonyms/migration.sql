-- P6-S.4 search synonyms: staff-managed groups the product search expands the search text with.

-- CreateEnum
CREATE TYPE "SearchSynonymKind" AS ENUM ('TWO_WAY', 'ONE_WAY');

-- CreateTable
CREATE TABLE "SearchSynonym" (
    "id" TEXT NOT NULL,
    "kind" "SearchSynonymKind" NOT NULL,
    "term" VARCHAR(100),
    "synonyms" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchSynonym_pkey" PRIMARY KEY ("id")
);

-- The service validates the terms (synonym-rules.ts); these keep the shape the search relies on.
ALTER TABLE "SearchSynonym" ADD CONSTRAINT "SearchSynonym_term_by_kind"
  CHECK (("kind" = 'ONE_WAY') = ("term" IS NOT NULL));
ALTER TABLE "SearchSynonym" ADD CONSTRAINT "SearchSynonym_synonym_count"
  CHECK (cardinality("synonyms") BETWEEN CASE WHEN "kind" = 'TWO_WAY' THEN 2 ELSE 1 END AND 20);
