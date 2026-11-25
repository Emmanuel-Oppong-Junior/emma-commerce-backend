-- P6-G.1 guest checkout: guest carts (token hash, idle expiry, phone verified by SMS code), guest orders (no account
-- until the verified phone is claimed), and redemptions and notifications without an account.

-- Guest carts
ALTER TABLE "Cart" ADD COLUMN "guestExpiresAt" TIMESTAMP(3),
ADD COLUMN "guestPhone" TEXT,
ADD COLUMN "guestPhoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN "guestTokenHash" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

CREATE UNIQUE INDEX "Cart_guestTokenHash_key" ON "Cart"("guestTokenHash");
CREATE INDEX "Cart_guestExpiresAt_idx" ON "Cart"("guestExpiresAt");

-- A cart belongs to an account or is a guest cart with a token and an expiry, never both.
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_owner_or_guest" CHECK (
  ("userId" IS NOT NULL AND "guestTokenHash" IS NULL AND "guestExpiresAt" IS NULL AND "guestPhone" IS NULL
    AND "guestPhoneVerifiedAt" IS NULL)
  OR ("userId" IS NULL AND "guestTokenHash" IS NOT NULL AND "guestExpiresAt" IS NOT NULL)
);
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_guest_phone_verified" CHECK (
  "guestPhoneVerifiedAt" IS NULL OR "guestPhone" IS NOT NULL
);

-- Guest orders
ALTER TABLE "Order" ADD COLUMN "contactName" TEXT,
ADD COLUMN "guestPhone" TEXT,
ADD COLUMN "guestPhoneVerifiedAt" TIMESTAMP(3),
ALTER COLUMN "userId" DROP NOT NULL,
ALTER COLUMN "contactEmail" DROP NOT NULL;

CREATE INDEX "Order_guestPhone_idx" ON "Order"("guestPhone");

-- An order without an account is a guest order with a verified phone and a name; only guest orders may lack an email;
-- guest orders are paid online (cash on delivery needs an account with a verified phone).
ALTER TABLE "Order" ADD CONSTRAINT "Order_guest_verified_phone" CHECK (
  "userId" IS NOT NULL OR ("guestPhone" IS NOT NULL AND "guestPhoneVerifiedAt" IS NOT NULL AND "contactName" IS NOT NULL)
);
ALTER TABLE "Order" ADD CONSTRAINT "Order_guest_phone_verified" CHECK (
  ("guestPhone" IS NULL) = ("guestPhoneVerifiedAt" IS NULL)
);
ALTER TABLE "Order" ADD CONSTRAINT "Order_contact_email" CHECK (
  "contactEmail" IS NOT NULL OR "guestPhone" IS NOT NULL
);
ALTER TABLE "Order" ADD CONSTRAINT "Order_guest_paid_online" CHECK (
  "guestPhone" IS NULL OR "paymentMethod" = 'ONLINE'
);

-- Redemptions of guest orders
ALTER TABLE "Redemption" ALTER COLUMN "customerId" DROP NOT NULL;

-- Messages to guests: no account, so the row names the guest order or cart it was about.
ALTER TABLE "Notification" ALTER COLUMN "userId" DROP NOT NULL;

CREATE INDEX "Notification_refType_refId_idx" ON "Notification"("refType", "refId");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_user_or_ref" CHECK (
  "userId" IS NOT NULL OR ("refType" IS NOT NULL AND "refId" IS NOT NULL)
);
