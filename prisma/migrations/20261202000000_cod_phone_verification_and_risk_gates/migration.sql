-- CreateEnum
CREATE TYPE "CodBlacklistKind" AS ENUM ('PHONE', 'GHANA_POST_GPS', 'STREET_ADDRESS');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "codPhone" TEXT;

-- AlterTable
ALTER TABLE "ShippingZone" ADD COLUMN     "codEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "codMaxOpenOrdersPerPhone" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "codMaxOrderTotal" DECIMAL(14,2) NOT NULL DEFAULT 2000;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "phoneVerifiedNumber" TEXT;

-- CreateTable
CREATE TABLE "CodBlacklistEntry" (
    "id" TEXT NOT NULL,
    "kind" "CodBlacklistKind" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodBlacklistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CodBlacklistEntry_kind_value_key" ON "CodBlacklistEntry"("kind", "value");

-- CreateIndex
CREATE INDEX "Order_codPhone_idx" ON "Order"("codPhone");

-- AddForeignKey
ALTER TABLE "CodBlacklistEntry" ADD CONSTRAINT "CodBlacklistEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The COD risk gates need a positive cap and at least one open order (P3-B.2).
ALTER TABLE "Store" ADD CONSTRAINT "Store_codMaxOpenOrdersPerPhone_check" CHECK ("codMaxOpenOrdersPerPhone" BETWEEN 1 AND 100);
ALTER TABLE "Store" ADD CONSTRAINT "Store_codMaxOrderTotal_check" CHECK ("codMaxOrderTotal" > 0);

-- A changed phone number is no longer verified, whichever code path changes it (P3-B.1).
CREATE OR REPLACE FUNCTION user_phone_change_clears_verification() RETURNS trigger AS $$
BEGIN
  NEW."phoneVerifiedAt" := NULL;
  NEW."phoneVerifiedNumber" := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "User_phone_change_clears_verification"
  BEFORE UPDATE OF "phoneNumber" ON "User"
  FOR EACH ROW
  WHEN (NEW."phoneNumber" IS DISTINCT FROM OLD."phoneNumber")
  EXECUTE FUNCTION user_phone_change_clears_verification();
