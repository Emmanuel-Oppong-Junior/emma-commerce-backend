-- P3-A.2: store-level payment provider credentials and payment-method switches. The defaults keep today's behaviour:
-- card and mobile money online through Paystack, and cash on delivery, all on.

-- CreateEnum
CREATE TYPE "PaymentProviderMode" AS ENUM ('TEST', 'LIVE');

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "cardPaymentProvider" "PaymentProvider" NOT NULL DEFAULT 'PAYSTACK',
ADD COLUMN     "cardPaymentsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "cashOnDeliveryEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "mobileMoneyPaymentProvider" "PaymentProvider" NOT NULL DEFAULT 'PAYSTACK',
ADD COLUMN     "mobileMoneyPaymentsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "PaymentProviderConfig" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "mode" "PaymentProviderMode" NOT NULL,
    "encryptedSecretKey" TEXT NOT NULL,
    "secretKeyLast4" TEXT NOT NULL,
    "publicKey" TEXT,
    "callbackUrl" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderConfig_storeId_provider_key" ON "PaymentProviderConfig"("storeId", "provider");

-- AddForeignKey
ALTER TABLE "PaymentProviderConfig" ADD CONSTRAINT "PaymentProviderConfig_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentProviderConfig" ADD CONSTRAINT "PaymentProviderConfig_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Card and mobile money are paid online, so an online provider serves them, never cash on delivery; and only online
-- providers have credentials.
ALTER TABLE "Store" ADD CONSTRAINT "Store_cardPaymentProvider_online" CHECK ("cardPaymentProvider" <> 'CASH_ON_DELIVERY');
ALTER TABLE "Store" ADD CONSTRAINT "Store_mobileMoneyPaymentProvider_online" CHECK ("mobileMoneyPaymentProvider" <> 'CASH_ON_DELIVERY');
ALTER TABLE "PaymentProviderConfig" ADD CONSTRAINT "PaymentProviderConfig_provider_online" CHECK ("provider" <> 'CASH_ON_DELIVERY');

-- Who may set provider keys and switch methods: the new payment.settings.manage permission, recorded on the Owner role
-- only (the Owner holds every permission anyway; nobody else is granted it). Safe to re-run.
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'payment.settings.manage'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'OWNER'
  AND NOT ('payment.settings.manage' = ANY ("permissions"));
