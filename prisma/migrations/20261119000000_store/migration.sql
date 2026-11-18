-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "legalName" TEXT NOT NULL,
    "tradingName" TEXT NOT NULL,
    "tin" TEXT,
    "vatRegistered" BOOLEAN NOT NULL DEFAULT false,
    "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT true,
    "currency" "Currency" NOT NULL DEFAULT 'GHS',
    "supportEmail" TEXT,
    "supportPhone" TEXT,
    "nextOrderNumber" INTEGER NOT NULL DEFAULT 10001,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Store_singleton_key" ON "Store"("singleton");

-- One deployment serves one store (ADR-0001): "singleton" is unique and can only be true, so a second row is rejected.
ALTER TABLE "Store" ADD CONSTRAINT "Store_singleton_true" CHECK ("singleton");
ALTER TABLE "Store" ADD CONSTRAINT "Store_nextOrderNumber_positive" CHECK ("nextOrderNumber" > 0);

-- The owner edits the placeholder names. Numbering continues after the highest existing order number.
INSERT INTO "Store" ("id", "legalName", "tradingName", "nextOrderNumber", "updatedAt")
SELECT 'store', 'My Store', 'My Store', GREATEST(10001, COALESCE(MAX("orderNumber"), 0) + 1), CURRENT_TIMESTAMP
FROM "Order"
ON CONFLICT ("singleton") DO NOTHING;

-- Order numbers now come from "Store"."nextOrderNumber", taken in the order transaction, not from a global sequence.
ALTER TABLE "Order" ALTER COLUMN "orderNumber" DROP DEFAULT;
DROP SEQUENCE IF EXISTS "Order_orderNumber_seq";
