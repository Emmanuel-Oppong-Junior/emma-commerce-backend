// Dry run of the payment ledger backfill (migration 20261117220000_payment_ledger, step M3).
// Read-only: reports what the migration would create from the legacy "Payment" table and which rows need ops
// review. Run it against the target database BEFORE `prisma migrate deploy`.
//
//   DATABASE_URL=... node scripts/payment-ledger-backfill-report.js          human-readable report
//   DATABASE_URL=... node scripts/payment-ledger-backfill-report.js --json   machine-readable report
//
// Exit code 2 means the migration would refuse to run (blocking findings).
const { PrismaClient } = require('@prisma/client');

const asJson = process.argv.includes('--json');
const prisma = new PrismaClient();

const SUMMARY_QUERIES = {
  payments: `SELECT count(*)::int AS n FROM "Payment"`,
  paymentsByStatus: `SELECT status::text AS status, count(*)::int AS n FROM "Payment" GROUP BY status ORDER BY status`,
  softDeletedPayments: `SELECT count(*)::int AS n FROM "Payment" WHERE deleted`,
  intentsToCreate: `SELECT count(DISTINCT "orderId")::int AS n FROM "Payment"`,
  paidIntents: `SELECT count(DISTINCT "orderId")::int AS n FROM "Payment" WHERE status = 'COMPLETED'`,
  attemptsByProvider: `
    SELECT CASE WHEN o."paymentMethod" = 'CASH_ON_DELIVERY' OR p."paymentMethod" = 'CASH_ON_DELIVERY'
                THEN 'CASH_ON_DELIVERY' ELSE 'PAYSTACK' END AS provider, count(*)::int AS n
    FROM "Payment" p JOIN "Order" o ON o.id = p."orderId" GROUP BY 1 ORDER BY 1`,
  cashCollectionsToCreate: `
    SELECT count(*)::int AS n FROM "Payment" p JOIN "Order" o ON o.id = p."orderId"
    WHERE p.status = 'COMPLETED' AND (o."paymentMethod" = 'CASH_ON_DELIVERY' OR p."paymentMethod" = 'CASH_ON_DELIVERY')`,
  refundsToCreate: `
    SELECT count(*)::int AS n FROM "ReturnRequest" r JOIN "Payment" p ON p."orderId" = r."orderId"
    WHERE r.status = 'REFUNDED' AND r."refundAmount" IS NOT NULL AND p."transactionId" IS NOT NULL`,
};

const FLAG_QUERIES = [
  {
    code: 'duplicate_reference',
    blocking: true,
    explain: 'Several payments share one Paystack reference; the migration stops until ops decide which row owns it.',
    sql: `
      SELECT p.id AS "paymentId", p."orderId", p."transactionId" AS reference, p.status::text AS status, p.amount::text AS amount
      FROM "Payment" p
      WHERE p."transactionId" IN (
        SELECT "transactionId" FROM "Payment" WHERE "transactionId" IS NOT NULL GROUP BY 1 HAVING count(*) > 1)
      ORDER BY p."transactionId", p."createdAt"`,
  },
  {
    code: 'online_payment_without_reference',
    explain: 'Online payment with no Paystack reference: it cannot be verified or reconciled against the export.',
    sql: `
      SELECT p.id AS "paymentId", p."orderId", p.status::text AS status, p.amount::text AS amount
      FROM "Payment" p JOIN "Order" o ON o.id = p."orderId"
      WHERE p."transactionId" IS NULL AND o."paymentMethod" = 'ONLINE' AND p."paymentMethod" <> 'CASH_ON_DELIVERY'`,
  },
  {
    code: 'currency_not_ghs',
    explain: 'Charged in a currency other than GHS (before P0-B.6); the attempt keeps its currency, the intent is GHS.',
    sql: `
      SELECT p.id AS "paymentId", p."orderId", p."transactionId" AS reference, p.currency, p.amount::text AS amount
      FROM "Payment" p WHERE p.currency <> 'GHS'`,
  },
  {
    code: 'amount_differs_from_order_total',
    explain: 'Payment amount differs from the order total; the intent takes the order total.',
    sql: `
      SELECT p.id AS "paymentId", p."orderId", p."transactionId" AS reference, p.amount::text AS amount,
             o."totalAmount"::text AS "orderTotal"
      FROM "Payment" p JOIN "Order" o ON o.id = p."orderId" WHERE p.amount <> o."totalAmount"`,
  },
  {
    code: 'payment_method_mismatch',
    explain: 'Order and payment disagree on cash on delivery; the attempt is recorded as cash on delivery.',
    sql: `
      SELECT p.id AS "paymentId", p."orderId", p."paymentMethod" AS "paymentChannel", o."paymentMethod"::text AS "orderMethod"
      FROM "Payment" p JOIN "Order" o ON o.id = p."orderId"
      WHERE (o."paymentMethod" = 'CASH_ON_DELIVERY') <> (p."paymentMethod" = 'CASH_ON_DELIVERY')`,
  },
  {
    code: 'completed_payment_on_unpaid_or_cancelled_order',
    explain: 'Money captured but the order is still PENDING or was CANCELLED: refund or fulfil (DB-01 victims).',
    sql: `
      SELECT p.id AS "paymentId", p."orderId", p."transactionId" AS reference, p.amount::text AS amount,
             o.status::text AS "orderStatus"
      FROM "Payment" p JOIN "Order" o ON o.id = p."orderId"
      WHERE p.status = 'COMPLETED' AND o.status IN ('PENDING', 'CANCELLED')
        AND NOT EXISTS (SELECT 1 FROM "ReturnRequest" r WHERE r."orderId" = o.id AND r.status = 'REFUNDED')`,
  },
  {
    code: 'refunded_request_not_mapped',
    explain: 'REFUNDED return request with no payment reference or no amount: no Refund row is created for it.',
    sql: `
      SELECT r.id AS "returnRequestId", r."orderId", r."refundAmount"::text AS "refundAmount", p.id AS "paymentId"
      FROM "ReturnRequest" r LEFT JOIN "Payment" p ON p."orderId" = r."orderId"
      WHERE r.status = 'REFUNDED' AND (r."refundAmount" IS NULL OR p."transactionId" IS NULL)`,
  },
  {
    code: 'refund_on_uncompleted_payment',
    explain: 'A refund was sent for a payment that was never marked COMPLETED.',
    sql: `
      SELECT r.id AS "returnRequestId", r."orderId", p.id AS "paymentId", p.status::text AS status
      FROM "ReturnRequest" r JOIN "Payment" p ON p."orderId" = r."orderId"
      WHERE r.status = 'REFUNDED' AND p.status <> 'COMPLETED'`,
  },
  {
    code: 'refund_exceeds_payment',
    explain: 'Refund amount is larger than the amount paid.',
    sql: `
      SELECT r.id AS "returnRequestId", r."orderId", r."refundAmount"::text AS "refundAmount", p.amount::text AS paid
      FROM "ReturnRequest" r JOIN "Payment" p ON p."orderId" = r."orderId"
      WHERE r.status = 'REFUNDED' AND r."refundAmount" > p.amount`,
  },
  {
    code: 'soft_deleted_payment',
    explain: 'Hidden by an admin; migrated with deleted = true so it stays hidden but kept.',
    sql: `SELECT p.id AS "paymentId", p."orderId", p."transactionId" AS reference, p.status::text AS status FROM "Payment" p WHERE p.deleted`,
  },
];

async function legacyTableExists() {
  const [row] = await prisma.$queryRawUnsafe(`SELECT to_regclass('"Payment"') IS NOT NULL AS present`);
  return row.present;
}

async function buildReport() {
  const summary = {};
  for (const [name, sql] of Object.entries(SUMMARY_QUERIES)) {
    const rows = await prisma.$queryRawUnsafe(sql);
    summary[name] = rows.length === 1 && 'n' in rows[0] ? rows[0].n : rows;
  }
  const flags = [];
  for (const flag of FLAG_QUERIES) {
    const rows = await prisma.$queryRawUnsafe(flag.sql);
    flags.push({ code: flag.code, blocking: Boolean(flag.blocking), explain: flag.explain, count: rows.length, rows });
  }
  return { summary, flags, blocking: flags.some((f) => f.blocking && f.count > 0) };
}

function printText(report) {
  const { summary } = report;
  console.log('Payment ledger backfill: dry run (no changes made)\n');
  console.log(`Legacy Payment rows:         ${summary.payments} (soft-deleted: ${summary.softDeletedPayments})`);
  for (const { status, n } of summary.paymentsByStatus) console.log(`  ${status.padEnd(26)} ${n}`);
  console.log(`PaymentIntent rows to create: ${summary.intentsToCreate} (PAID: ${summary.paidIntents})`);
  console.log(`PaymentAttempt rows to create: ${summary.payments}`);
  for (const { provider, n } of summary.attemptsByProvider) console.log(`  ${provider.padEnd(26)} ${n}`);
  console.log(`CashCollection rows to create: ${summary.cashCollectionsToCreate}`);
  console.log(`Refund rows to create (PENDING): ${summary.refundsToCreate}\n`);
  for (const flag of report.flags) {
    const tag = flag.blocking && flag.count > 0 ? 'BLOCKING ' : '';
    console.log(`${tag}${flag.code}: ${flag.count}`);
    if (flag.count === 0) continue;
    console.log(`  ${flag.explain}`);
    for (const row of flag.rows) console.log(`  ${JSON.stringify(row)}`);
  }
  console.log(
    '\nOps step (not automated): match every PAYSTACK reference against the Paystack transaction export.' +
      '\nSuccessful export references missing here are payments lost to delete-and-retry (DB-01): refund or fulfil them.',
  );
  console.log(report.blocking ? '\nResult: the migration would STOP. Resolve the blocking rows first.' : '\nResult: OK to migrate.');
}

async function main() {
  if (!(await legacyTableExists())) {
    console.log('No legacy "Payment" table: the payment ledger migration has already been applied.');
    return;
  }
  const report = await buildReport();
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else printText(report);
  if (report.blocking) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(`Backfill report failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
