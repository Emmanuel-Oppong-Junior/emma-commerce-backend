-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "pickupLocationSnapshot" JSONB,
ADD COLUMN     "shippingFee" DECIMAL(10,2),
ADD COLUMN     "subtotal" DECIMAL(10,2);
