-- P8-A: daily analytics rollups. Rebuilt by the analytics.rollup maintenance job (today and the 7 days before) and
-- by the rebuildAnalytics backfill (any range of up to 731 days); empty until then. No backfill here: run
-- rebuildAnalytics for the history after deploying.

-- CreateTable
CREATE TABLE "AnalyticsDailySales" (
    "day" DATE NOT NULL,
    "paidOrders" INTEGER NOT NULL,
    "unitsSold" INTEGER NOT NULL,
    "grossRevenue" DECIMAL(14,2) NOT NULL,
    "itemSales" DECIMAL(14,2) NOT NULL,
    "itemDiscounts" DECIMAL(14,2) NOT NULL,
    "orderDiscounts" DECIMAL(14,2) NOT NULL,
    "loyaltyDiscounts" DECIMAL(14,2) NOT NULL,
    "shipping" DECIMAL(14,2) NOT NULL,
    "shippingDiscounts" DECIMAL(14,2) NOT NULL,
    "tax" DECIMAL(14,2) NOT NULL,
    "refundCount" INTEGER NOT NULL,
    "refunds" DECIMAL(14,2) NOT NULL,
    "refundedShipping" DECIMAL(14,2) NOT NULL,
    "refundedTax" DECIMAL(14,2) NOT NULL,
    "unallocatedRefunds" DECIMAL(14,2) NOT NULL,
    "ordersPlaced" INTEGER NOT NULL,
    "cartsStarted" INTEGER NOT NULL DEFAULT 0,
    "checkoutQuotes" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsDailySales_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "AnalyticsDailyVariant" (
    "day" DATE NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitsSold" INTEGER NOT NULL,
    "sales" DECIMAL(14,2) NOT NULL,
    "unitsRefunded" INTEGER NOT NULL,
    "refunds" DECIMAL(14,2) NOT NULL,
    "unitsRestocked" INTEGER NOT NULL,
    "costedNetSales" DECIMAL(14,2) NOT NULL,
    "cogs" DECIMAL(16,4) NOT NULL,
    "unknownCostUnits" INTEGER NOT NULL,
    "unknownCostNetSales" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "AnalyticsDailyVariant_pkey" PRIMARY KEY ("day","variantId")
);

-- CreateTable
CREATE TABLE "AnalyticsDailyPromotion" (
    "day" DATE NOT NULL,
    "promotionId" TEXT NOT NULL,
    "couponCode" TEXT NOT NULL DEFAULT '',
    "orders" INTEGER NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL,
    "revenue" DECIMAL(14,2) NOT NULL,
    "units" INTEGER NOT NULL,

    CONSTRAINT "AnalyticsDailyPromotion_pkey" PRIMARY KEY ("day","promotionId","couponCode")
);

-- CreateTable
CREATE TABLE "AnalyticsDailyCustomer" (
    "day" DATE NOT NULL,
    "customerKey" TEXT NOT NULL,
    "orders" INTEGER NOT NULL,
    "revenue" DECIMAL(14,2) NOT NULL,
    "refunds" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "AnalyticsDailyCustomer_pkey" PRIMARY KEY ("day","customerKey")
);

-- CreateIndex
CREATE INDEX "AnalyticsDailyVariant_productId_day_idx" ON "AnalyticsDailyVariant"("productId", "day");

-- CreateIndex
CREATE INDEX "AnalyticsDailyPromotion_promotionId_day_idx" ON "AnalyticsDailyPromotion"("promotionId", "day");

-- CreateIndex
CREATE INDEX "AnalyticsDailyCustomer_customerKey_day_idx" ON "AnalyticsDailyCustomer"("customerKey", "day");
