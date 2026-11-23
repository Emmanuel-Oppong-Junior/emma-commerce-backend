-- P5-C.2: proof of delivery. One append-only row per rider-delivered shipment: confirmed with the customer's code or a
-- staff override (with a reason), an optional photo, recipient name and position. The new delivery.override
-- permission goes to the Owner and Manager roles (safe to re-run).

-- CreateEnum
CREATE TYPE "ProofOfDeliveryMethod" AS ENUM ('CODE', 'OVERRIDE');

-- CreateTable
CREATE TABLE "ProofOfDelivery" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "method" "ProofOfDeliveryMethod" NOT NULL,
    "overrideReason" TEXT,
    "deliveredById" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL,
    "photoUrl" TEXT,
    "photoPublicId" TEXT,
    "recipientName" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProofOfDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProofOfDelivery_shipmentId_key" ON "ProofOfDelivery"("shipmentId");

-- CreateIndex
CREATE INDEX "ProofOfDelivery_deliveredById_idx" ON "ProofOfDelivery"("deliveredById");

-- AddForeignKey
ALTER TABLE "ProofOfDelivery" ADD CONSTRAINT "ProofOfDelivery_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProofOfDelivery" ADD CONSTRAINT "ProofOfDelivery_deliveredById_fkey" FOREIGN KEY ("deliveredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProofOfDelivery" ADD CONSTRAINT "ProofOfDelivery_override_reason"
  CHECK (("method" = 'OVERRIDE') = ("overrideReason" IS NOT NULL AND btrim("overrideReason") <> ''));
ALTER TABLE "ProofOfDelivery" ADD CONSTRAINT "ProofOfDelivery_photo"
  CHECK (("photoUrl" IS NULL) = ("photoPublicId" IS NULL));
ALTER TABLE "ProofOfDelivery" ADD CONSTRAINT "ProofOfDelivery_position"
  CHECK (
    ("latitude" IS NULL) = ("longitude" IS NULL)
    AND ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90)
    AND ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180)
  );

-- Append-only. Deleting the shipment (or its order) still removes its proof: those deletes run inside the foreign-key
-- cascade trigger, one trigger level deeper than a direct DELETE.
CREATE FUNCTION "proof_of_delivery_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ProofOfDelivery is append-only: % refused', TG_OP;
END $$;
CREATE TRIGGER "ProofOfDelivery_append_only" BEFORE UPDATE OR DELETE ON "ProofOfDelivery"
  FOR EACH ROW EXECUTE FUNCTION "proof_of_delivery_append_only"();

UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'delivery.override'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER') AND NOT ('delivery.override' = ANY ("permissions"));
