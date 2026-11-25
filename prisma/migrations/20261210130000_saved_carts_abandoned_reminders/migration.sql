-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "abandonedCartReminderDelayHours" INTEGER NOT NULL DEFAULT 4;

-- CreateTable
CREATE TABLE "SavedCartItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedCartItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbandonedCartReminder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cartStateHash" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbandonedCartReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedCartItem_variantId_idx" ON "SavedCartItem"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedCartItem_userId_variantId_key" ON "SavedCartItem"("userId", "variantId");

-- CreateIndex
CREATE INDEX "AbandonedCartReminder_userId_sentAt_idx" ON "AbandonedCartReminder"("userId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "AbandonedCartReminder_userId_cartStateHash_key" ON "AbandonedCartReminder"("userId", "cartStateHash");

-- AddForeignKey
ALTER TABLE "SavedCartItem" ADD CONSTRAINT "SavedCartItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedCartItem" ADD CONSTRAINT "SavedCartItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbandonedCartReminder" ADD CONSTRAINT "AbandonedCartReminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Quantities are positive; the reminder delay is between 1 hour and 3 days.
ALTER TABLE "SavedCartItem" ADD CONSTRAINT "SavedCartItem_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "Store" ADD CONSTRAINT "Store_abandoned_cart_delay_range"
  CHECK ("abandonedCartReminderDelayHours" BETWEEN 1 AND 72);
