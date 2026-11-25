-- P6-V.2: product questions. Customers ask, staff with review.moderate answer; a question is public once answered and
-- not hidden. Reports and hiding work as for reviews. New tables only, nothing to backfill.

-- CreateTable
CREATE TABLE "ProductQuestion" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "answer" VARCHAR(2000),
    "answeredAt" TIMESTAMP(3),
    "status" "ModerationStatus" NOT NULL DEFAULT 'PUBLISHED',
    "hiddenReason" TEXT,
    "hiddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductQuestionReport" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" "ContentReportReason" NOT NULL,
    "note" VARCHAR(500),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductQuestionReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductQuestion_productId_status_answeredAt_idx" ON "ProductQuestion"("productId", "status", "answeredAt");

-- CreateIndex
CREATE INDEX "ProductQuestion_userId_createdAt_idx" ON "ProductQuestion"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductQuestionReport_reporterId_idx" ON "ProductQuestionReport"("reporterId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductQuestionReport_questionId_reporterId_key" ON "ProductQuestionReport"("questionId", "reporterId");

-- AddForeignKey
ALTER TABLE "ProductQuestion" ADD CONSTRAINT "ProductQuestion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductQuestion" ADD CONSTRAINT "ProductQuestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductQuestionReport" ADD CONSTRAINT "ProductQuestionReport_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ProductQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductQuestionReport" ADD CONSTRAINT "ProductQuestionReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductQuestion" ADD CONSTRAINT "ProductQuestion_body" CHECK (btrim("body") <> '');
ALTER TABLE "ProductQuestion" ADD CONSTRAINT "ProductQuestion_answer"
  CHECK (("answer" IS NULL) = ("answeredAt" IS NULL) AND ("answer" IS NULL OR btrim("answer") <> ''));
ALTER TABLE "ProductQuestion" ADD CONSTRAINT "ProductQuestion_hidden"
  CHECK (("status" = 'HIDDEN') = ("hiddenAt" IS NOT NULL AND "hiddenReason" IS NOT NULL));
