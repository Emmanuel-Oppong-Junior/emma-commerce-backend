-- DropIndex
DROP INDEX "RefreshToken_tokenHash_idx";

-- DropIndex
DROP INDEX "Product_sku_idx";

-- DropIndex
DROP INDEX "Order_userId_idx";

-- DropIndex
DROP INDEX "Order_deleted_idx";

-- DropIndex
DROP INDEX "Order_trackingNumber_idx";

-- DropIndex
DROP INDEX "Coupon_code_idx";

-- DropIndex
DROP INDEX "CouponUsage_couponId_idx";

-- DropIndex
DROP INDEX "ReturnRequest_status_idx";

-- DropIndex
DROP INDEX "InventoryLog_action_idx";

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

