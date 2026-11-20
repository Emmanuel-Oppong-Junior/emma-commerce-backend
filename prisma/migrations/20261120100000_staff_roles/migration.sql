-- Permission-based RBAC (P1-R.1, ADR-0013): roles as data and one staff membership per user in the single store.
-- Permissions are code constants (src/iam/authorization/permissions.ts). The legacy "User"."role" column stays and
-- is kept in step by the application (OWNER -> SUPER_ADMIN, other staff -> ADMIN, none -> USER).

-- CreateTable
CREATE TABLE "StaffRole" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "mfaRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffRole_key_key" ON "StaffRole"("key");

-- CreateIndex
CREATE INDEX "StoreMembership_roleId_idx" ON "StoreMembership"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreMembership_userId_storeId_key" ON "StoreMembership"("userId", "storeId");

-- AddForeignKey
ALTER TABLE "StoreMembership" ADD CONSTRAINT "StoreMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreMembership" ADD CONSTRAINT "StoreMembership_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreMembership" ADD CONSTRAINT "StoreMembership_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "StaffRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- System roles. Owner holds every permission (the application also grants it any permission added later).
-- Manager keeps exactly what ADMIN could do. Pharmacist and Rider wait for their verticals.
INSERT INTO "StaffRole" ("id", "key", "name", "permissions", "isSystem", "mfaRequired", "updatedAt") VALUES
  ('staff_role_owner', 'OWNER', 'Owner', ARRAY[
    'catalog.product.read', 'catalog.product.write', 'catalog.taxonomy.write', 'catalog.media.upload',
    'inventory.view', 'inventory.adjust', 'order.view', 'order.manage', 'order.refund', 'return.manage',
    'payment.view', 'payment.record', 'payment.manage', 'promotion.manage', 'tax.manage', 'shipping.manage',
    'review.moderate', 'user.view', 'user.manage', 'customer.data.export', 'staff.view', 'staff.manage',
    'report.view', 'store.settings.manage', 'jobs.manage'
  ]::TEXT[], true, true, CURRENT_TIMESTAMP),
  ('staff_role_manager', 'MANAGER', 'Manager', ARRAY[
    'catalog.product.read', 'catalog.product.write', 'catalog.taxonomy.write', 'catalog.media.upload',
    'inventory.view', 'inventory.adjust', 'order.view', 'order.manage', 'order.refund', 'return.manage',
    'payment.view', 'payment.record', 'payment.manage', 'promotion.manage', 'tax.manage', 'shipping.manage',
    'review.moderate', 'user.view', 'user.manage', 'staff.view', 'report.view'
  ]::TEXT[], true, true, CURRENT_TIMESTAMP),
  ('staff_role_inventory_clerk', 'INVENTORY_CLERK', 'Inventory clerk', ARRAY[
    'catalog.product.read', 'catalog.product.write', 'catalog.taxonomy.write', 'catalog.media.upload',
    'inventory.view', 'inventory.adjust'
  ]::TEXT[], true, false, CURRENT_TIMESTAMP),
  ('staff_role_cashier', 'CASHIER', 'Cashier', ARRAY[
    'catalog.product.read', 'order.view', 'payment.view', 'payment.record'
  ]::TEXT[], true, false, CURRENT_TIMESTAMP),
  ('staff_role_support', 'SUPPORT', 'Support', ARRAY[
    'order.view', 'return.manage', 'payment.view', 'user.view', 'review.moderate'
  ]::TEXT[], true, false, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- Backfill, safe to re-run: SUPER_ADMIN -> Owner, ADMIN -> Manager, in the single store row.
INSERT INTO "StoreMembership" ("id", "userId", "storeId", "roleId", "updatedAt")
SELECT 'membership_' || u."id", u."id", s."id", r."id", CURRENT_TIMESTAMP
FROM "User" u
CROSS JOIN "Store" s
JOIN "StaffRole" r ON r."key" = CASE u."role" WHEN 'SUPER_ADMIN' THEN 'OWNER' ELSE 'MANAGER' END
WHERE u."role" IN ('ADMIN', 'SUPER_ADMIN')
ON CONFLICT ("userId", "storeId") DO NOTHING;
