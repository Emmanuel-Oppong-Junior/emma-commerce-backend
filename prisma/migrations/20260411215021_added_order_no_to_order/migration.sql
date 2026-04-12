-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "orderNumber" SET DEFAULT nextval('order_number_seq'::regclass);
