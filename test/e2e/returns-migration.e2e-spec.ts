import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { migrationSql, migrationSqlFrom, ScratchSchema } from '../helpers/migration.helper';

const BEFORE = '20261208110000_proof_of_delivery';
const MIGRATION = '20261211100000_item_returns';
const REPORT = join(__dirname, '../../scripts/reports/returns-migration-report.sql');

// Whole-order requests as they were before P6-R.1: an open request on a delivered order where one unit was already
// refunded outside returns (plus an older duplicate), the automatic request of a cancelled paid order (nothing
// delivered), an approved one with its amount and a rejected one with an admin note.
const LEGACY_DATA = `
INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('u1', 'legacy-returns@test.local', now());
INSERT INTO "Product" ("id", "name", "updatedAt") VALUES ('p1', 'Mug', now());
INSERT INTO "Variant" ("id", "productId", "sku", "optionsKey", "price", "updatedAt") VALUES ('v1', 'p1', 'MUG', '', 100, now());
INSERT INTO "Order" ("id", "orderNumber", "userId", "currency", "pricingVersion", "subtotal", "discountTotal", "taxTotal",
                     "shippingTotal", "grandTotal", "status", "contactEmail", "contactPhone", "updatedAt") VALUES
  ('o1', 1, 'u1', 'GHS', 5, 300, 0, 0, 0, 300, 'COMPLETED', 'legacy-returns@test.local', '+233200000000', now()),
  ('o2', 2, 'u1', 'GHS', 5, 100, 0, 0, 0, 100, 'CANCELLED', 'legacy-returns@test.local', '+233200000000', now()),
  ('o3', 3, 'u1', 'GHS', 5, 100, 0, 0, 0, 100, 'COMPLETED', 'legacy-returns@test.local', '+233200000000', now());
INSERT INTO "OrderItem" ("id", "orderId", "productId", "variantId", "productName", "quantity", "unitListPrice",
                         "unitDiscount", "unitNet", "unitTax", "lineTotal") VALUES
  ('i1', 'o1', 'p1', 'v1', 'Mug', 2, 100, 0, 100, 0, 200),
  ('i2', 'o1', 'p1', 'v1', 'Mug', 1, 100, 0, 100, 0, 100),
  ('i3', 'o2', 'p1', 'v1', 'Mug', 1, 100, 0, 100, 0, 100),
  ('i4', 'o3', 'p1', 'v1', 'Mug', 1, 100, 0, 100, 0, 100);
INSERT INTO "Shipment" ("id", "orderId", "status", "dispatchedAt", "deliveredAt", "updatedAt") VALUES
  ('s1', 'o1', 'DELIVERED', now(), now(), now()),
  ('s3', 'o3', 'DELIVERED', now(), now(), now());
INSERT INTO "ShipmentItem" ("id", "shipmentId", "orderItemId", "quantity") VALUES
  ('si1', 's1', 'i1', 2), ('si2', 's1', 'i2', 1), ('si4', 's3', 'i4', 1);
INSERT INTO "PaymentIntent" ("id", "orderId", "amount", "updatedAt") VALUES ('pi1', 'o1', 300, now());
INSERT INTO "PaymentAttempt" ("id", "intentId", "provider", "amount", "channel", "status", "updatedAt") VALUES
  ('pa1', 'pi1', 'PAYSTACK', 300, 'card', 'CAPTURED', now());
INSERT INTO "Refund" ("id", "attemptId", "amount", "idempotencyKey", "reason", "status", "updatedAt") VALUES
  ('r1', 'pa1', 100, 'staff:legacy-1', 'DAMAGED', 'PROCESSED', now());
INSERT INTO "RefundLine" ("id", "refundId", "orderItemId", "quantity", "amount") VALUES ('rl1', 'r1', 'i1', 1, 100);
INSERT INTO "ReturnRequest" ("id", "orderId", "userId", "reason", "status", "refundAmount", "adminNote", "createdAt", "updatedAt") VALUES
  ('rr_dup', 'o1', 'u1', 'First try', 'PENDING', NULL, NULL, now() - interval '2 days', now()),
  ('rr_open', 'o1', 'u1', 'Cracked handles', 'PENDING', NULL, NULL, now() - interval '1 day', now()),
  ('rr_cancel', 'o2', 'u1', 'Automatic refund request for cancelled paid order', 'PENDING', NULL, NULL, now(), now()),
  ('rr_approved', 'o3', 'u1', 'Wrong colour', 'APPROVED', 40, 'ok', now(), now()),
  ('rr_rejected', 'o3', 'u1', 'Too late', 'REJECTED', NULL, 'Out of policy', now() - interval '3 days', now());
`;

describe('Item-level returns migration on whole-order requests (P6-R.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let legacy: ScratchSchema;

  const snapshot = async () => ({
    requests: await legacy.query(
      `SELECT id, status::text, reason, "staffNote", resolution::text FROM "ReturnRequest" ORDER BY id`,
    ),
    lines: await legacy.query(
      `SELECT "returnRequestId", "orderItemId", quantity, reason::text, note FROM "ReturnLine" ORDER BY "orderItemId"`,
    ),
    events: await legacy.query(
      `SELECT "returnRequestId", "from"::text, "to"::text FROM "ReturnStatusEvent" ORDER BY "returnRequestId"`,
    ),
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    legacy = new ScratchSchema(prisma, 'legacy_item_returns');
    await legacy.recreate();
    await legacy.migrateTo(BEFORE);
    await legacy.exec(LEGACY_DATA);
    await legacy.exec(migrationSql(MIGRATION));
  });

  afterAll(async () => {
    await legacy.drop();
    await app.close();
  });

  it('keeps every request, renames PENDING to REQUESTED and the admin note to the staff note', async () => {
    const { requests } = await snapshot();
    expect(requests).toEqual([
      { id: 'rr_approved', status: 'APPROVED', reason: 'Wrong colour', staffNote: 'ok', resolution: 'REFUND' },
      {
        id: 'rr_cancel',
        status: 'REQUESTED',
        reason: 'Automatic refund request for cancelled paid order',
        staffNote: null,
        resolution: 'REFUND',
      },
      { id: 'rr_dup', status: 'REQUESTED', reason: 'First try', staffNote: null, resolution: 'REFUND' },
      { id: 'rr_open', status: 'REQUESTED', reason: 'Cracked handles', staffNote: null, resolution: 'REFUND' },
      { id: 'rr_rejected', status: 'REJECTED', reason: 'Too late', staffNote: 'Out of policy', resolution: 'REFUND' },
    ]);
  });

  it('gives the newest open request of a delivered order its returnable units as lines; the rest stay legacy', async () => {
    const { lines, events } = await snapshot();
    expect(lines).toEqual([
      { returnRequestId: 'rr_open', orderItemId: 'i1', quantity: 1, reason: 'OTHER', note: 'Cracked handles' },
      { returnRequestId: 'rr_open', orderItemId: 'i2', quantity: 1, reason: 'OTHER', note: 'Cracked handles' },
    ]);
    expect(events).toHaveLength(5);
    expect(events).toContainEqual({ returnRequestId: 'rr_approved', from: null, to: 'APPROVED' });
  });

  it('is safe to re-run, the trigger then refuses more units than delivered, and the report reads it', async () => {
    const first = await snapshot();

    await legacy.exec(migrationSqlFrom(MIGRATION, '-- Backfill: every existing request'));

    expect(await snapshot()).toEqual(first);
    await expect(
      legacy.exec(
        `INSERT INTO "ReturnLine" ("id", "returnRequestId", "orderItemId", "quantity", "reason") VALUES ('x', 'rr_dup', 'i2', 1, 'DAMAGED')`,
      ),
    ).rejects.toThrow(/would be returned or refunded, 1 delivered/);
    await expect(legacy.exec(readFileSync(REPORT, 'utf8'))).resolves.toBeUndefined();
  });
});
