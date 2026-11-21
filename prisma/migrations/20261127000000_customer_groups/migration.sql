-- Customer groups and first-order promotions (P2-B.3). Expand only: new columns and tables with defaults, nothing to
-- backfill. Customer groups are generic: promotions may be limited to them, and B2B price lists (P2-W) will reuse them.

-- AlterTable
ALTER TABLE "Promotion" ADD COLUMN     "firstOrderOnly" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CustomerGroup" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerGroupMember" (
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerGroupMember_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateTable
CREATE TABLE "_CustomerGroupToPromotion" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_CustomerGroupToPromotion_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerGroup_name_key" ON "CustomerGroup"("name");

-- CreateIndex
CREATE INDEX "CustomerGroupMember_userId_idx" ON "CustomerGroupMember"("userId");

-- CreateIndex
CREATE INDEX "_CustomerGroupToPromotion_B_index" ON "_CustomerGroupToPromotion"("B");

-- AddForeignKey
ALTER TABLE "CustomerGroupMember" ADD CONSTRAINT "CustomerGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CustomerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerGroupMember" ADD CONSTRAINT "CustomerGroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CustomerGroupToPromotion" ADD CONSTRAINT "_CustomerGroupToPromotion_A_fkey" FOREIGN KEY ("A") REFERENCES "CustomerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CustomerGroupToPromotion" ADD CONSTRAINT "_CustomerGroupToPromotion_B_fkey" FOREIGN KEY ("B") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Who may manage customer groups and their members: the new customer.group.manage permission, granted to the Owner
-- (who holds every permission) and the Manager. Safe to re-run.
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'customer.group.manage'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER')
  AND NOT ('customer.group.manage' = ANY ("permissions"));
