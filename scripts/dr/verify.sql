-- Integrity checks for a restored database (P9-D): the stock ledger, lots and serial units, the payment ledger,
-- sequences and the append-only triggers. Prints one row per check and exits 3 when any check fails. Safe on a live
-- database: everything runs in one transaction that is rolled back (the append-only probes try an UPDATE/DELETE that
-- the trigger must refuse), and it takes no locks beyond ordinary reads.
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/dr/verify.sql
\set ON_ERROR_STOP on
\pset footer off
BEGIN;
SET LOCAL statement_timeout = '10min';

CREATE TEMP TABLE verify_result (name text PRIMARY KEY, value bigint NOT NULL, ok boolean NOT NULL) ON COMMIT DROP;

-- Stock ledger: the three disagreements the nightly inventory.reconcile-stock job looks for (stock-ledger.repository.ts).
INSERT INTO verify_result
WITH keys AS (
  SELECT "variantId", "locationId" FROM "StockLevel"
  UNION SELECT "variantId", "locationId" FROM "StockMovement"
  UNION SELECT "variantId", "locationId" FROM "StockReservation" WHERE "status" = 'ACTIVE'
), moved AS (
  SELECT "variantId", "locationId", sum("onHandDelta") AS "onHand", sum("reservedDelta") AS "reserved"
  FROM "StockMovement" GROUP BY 1, 2
), held AS (
  SELECT "variantId", "locationId", sum("quantity") AS "quantity" FROM "StockReservation" WHERE "status" = 'ACTIVE' GROUP BY 1, 2
)
SELECT 'stock: level <> movements or active reservations', count(*), count(*) = 0
FROM keys k
LEFT JOIN "StockLevel" sl USING ("variantId", "locationId")
LEFT JOIN moved m USING ("variantId", "locationId")
LEFT JOIN held h USING ("variantId", "locationId")
WHERE COALESCE(sl."onHand", 0) <> COALESCE(m."onHand", 0)
   OR COALESCE(sl."reserved", 0) <> COALESCE(m."reserved", 0)
   OR COALESCE(sl."reserved", 0) <> COALESCE(h."quantity", 0);

INSERT INTO verify_result
WITH lot_keys AS (
  SELECT "lotId", "locationId" FROM "LotStock"
  UNION SELECT "lotId", "locationId" FROM "StockMovement" WHERE "lotId" IS NOT NULL
), lot_moved AS (
  SELECT "lotId", "locationId", sum("onHandDelta") AS "onHand" FROM "StockMovement" WHERE "lotId" IS NOT NULL GROUP BY 1, 2
)
SELECT 'lots: lot stock <> lot movements', count(*), count(*) = 0
FROM lot_keys k
LEFT JOIN "LotStock" ls USING ("lotId", "locationId")
LEFT JOIN lot_moved m USING ("lotId", "locationId")
WHERE COALESCE(ls."onHand", 0) <> COALESCE(m."onHand", 0);

INSERT INTO verify_result
WITH lot_totals AS (
  SELECT lt."variantId", ls."locationId", sum(ls."onHand") AS "onHand"
  FROM "LotStock" ls JOIN "Lot" lt ON lt."id" = ls."lotId" GROUP BY 1, 2
)
SELECT 'lots: tracked level <> sum of its lots', count(*), count(*) = 0
FROM "StockLevel" sl
JOIN "Variant" v ON v."id" = sl."variantId"
JOIN "Product" p ON p."id" = v."productId"
LEFT JOIN lot_totals t ON t."variantId" = sl."variantId" AND t."locationId" = sl."locationId"
WHERE p."trackLots" AND sl."onHand" <> COALESCE(t."onHand", 0);

-- Serial units on the shelf = onHand + units sold online not yet in a dispatched shipment (UNDISPATCHED_RESERVED_UNITS,
-- aggregated per order line first so it stays fast on large tables).
INSERT INTO verify_result
WITH tracked AS (
  SELECT v."id" AS "variantId" FROM "Variant" v JOIN "Product" p ON p."id" = v."productId" WHERE p."trackSerials"
), dispatched AS (
  SELECT si."orderItemId", sum(si."quantity") AS "quantity"
  FROM "ShipmentItem" si JOIN "Shipment" s ON s."id" = si."shipmentId"
  WHERE s."status" NOT IN ('PENDING', 'PICKING', 'PACKED', 'CANCELLED')
  GROUP BY 1
), awaiting_dispatch AS (
  SELECT r."variantId", r."locationId", sum(GREATEST(r."quantity" - COALESCE(d."quantity", 0), 0)) AS "quantity"
  FROM "StockReservation" r
  JOIN tracked USING ("variantId")
  JOIN "Order" o ON o."id" = r."orderId"
  LEFT JOIN dispatched d ON d."orderItemId" = r."orderItemId"
  WHERE r."status" = 'CONSUMED' AND o."status" IN ('CONFIRMED', 'IN_FULFILMENT')
  GROUP BY 1, 2
), on_shelf AS (
  SELECT "variantId", "locationId", count(*) AS "units" FROM "SerialUnit" WHERE "status" IN ('IN_STOCK', 'ASSIGNED') GROUP BY 1, 2
), keys AS (
  SELECT "variantId", "locationId" FROM "StockLevel"
  UNION SELECT "variantId", "locationId" FROM awaiting_dispatch
  UNION SELECT "variantId", "locationId" FROM on_shelf
)
SELECT 'serials: units on shelf <> onHand + awaiting dispatch', count(*), count(*) = 0
FROM keys k
JOIN tracked USING ("variantId")
LEFT JOIN "StockLevel" sl USING ("variantId", "locationId")
LEFT JOIN awaiting_dispatch ad USING ("variantId", "locationId")
LEFT JOIN on_shelf os USING ("variantId", "locationId")
WHERE COALESCE(sl."onHand", 0) + COALESCE(ad."quantity", 0) <> COALESCE(os."units", 0);

-- Payment ledger.
INSERT INTO verify_result
SELECT 'payments: intent amount <> order grand total', count(*), count(*) = 0
FROM "PaymentIntent" i JOIN "Order" o ON o."id" = i."orderId" WHERE i."amount" <> o."grandTotal";

INSERT INTO verify_result
WITH refunded AS (
  SELECT a."id", a."amount", COALESCE(sum(r."amount") FILTER (WHERE r."status" <> 'FAILED'), 0) AS "refunds"
  FROM "PaymentAttempt" a LEFT JOIN "Refund" r ON r."attemptId" = a."id" GROUP BY a."id", a."amount"
)
SELECT 'payments: refunds above the captured amount', count(*), count(*) = 0 FROM refunded WHERE "refunds" > "amount";

INSERT INTO verify_result
SELECT 'payments: refund on an attempt never captured', count(*), count(*) = 0
FROM "Refund" r JOIN "PaymentAttempt" a ON a."id" = r."attemptId" WHERE a."status" <> 'CAPTURED' AND r."status" <> 'FAILED';

INSERT INTO verify_result
WITH units AS (
  SELECT rl."orderItemId", sum(rl."quantity") AS "quantity"
  FROM "RefundLine" rl JOIN "Refund" r ON r."id" = rl."refundId" WHERE r."status" <> 'FAILED' GROUP BY 1
)
SELECT 'payments: refunded units above the line quantity', count(*), count(*) = 0
FROM units u JOIN "OrderItem" oi ON oi."id" = u."orderItemId" WHERE u."quantity" > oi."quantity";

-- A paid intent's status follows its processed refunds (statusAfterRefunds in payment-intent-status.ts).
INSERT INTO verify_result
WITH captured AS (
  SELECT "intentId", sum("amount") AS "amount" FROM "PaymentAttempt" WHERE "status" = 'CAPTURED' GROUP BY 1
), refunded AS (
  SELECT a."intentId", sum(r."amount") AS "amount"
  FROM "Refund" r JOIN "PaymentAttempt" a ON a."id" = r."attemptId" WHERE r."status" = 'PROCESSED' GROUP BY 1
), paid AS (
  SELECT i."status", c."amount" AS "captured", COALESCE(f."amount", 0) AS "refunded"
  FROM "PaymentIntent" i
  JOIN captured c ON c."intentId" = i."id"
  LEFT JOIN refunded f ON f."intentId" = i."id"
  WHERE i."status" IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED')
)
SELECT 'payments: paid intent status <> its refunds', count(*), count(*) = 0 FROM paid
WHERE "status"::text <> CASE WHEN "refunded" <= 0 THEN 'CAPTURED' WHEN "refunded" >= "captured" THEN 'REFUNDED'
                             ELSE 'PARTIALLY_REFUNDED' END;

INSERT INTO verify_result
SELECT 'payments: paid intent without a captured attempt', count(*), count(*) = 0
FROM "PaymentIntent" i
WHERE i."status" IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED')
  AND NOT EXISTS (SELECT 1 FROM "PaymentAttempt" a WHERE a."intentId" = i."id" AND a."status" = 'CAPTURED');

INSERT INTO verify_result
SELECT 'payments: captured cash attempt without its collection', count(*), count(*) = 0
FROM "PaymentAttempt" a
WHERE a."provider" = 'CASH_ON_DELIVERY' AND a."status" = 'CAPTURED'
  AND NOT EXISTS (SELECT 1 FROM "CashCollection" c WHERE c."attemptId" = a."id" AND c."amount" = a."amount");

INSERT INTO verify_result
SELECT 'payments: remittance <> its collections and discrepancy', count(*), count(*) = 0
FROM "CashRemittance" m
WHERE m."amount" - m."expectedAmount" <> m."discrepancy"
   OR m."expectedAmount" <> COALESCE((SELECT sum(c."amount") FROM "CashCollection" c WHERE c."remittanceId" = m."id"), 0);

-- Sequences continue after the restore: each column-owned sequence is at or past its column's maximum, and the store's
-- order-number counter is past every order number.
CREATE FUNCTION pg_temp.sequences_behind() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  s record;
  max_value bigint;
  behind bigint := 0;
BEGIN
  FOR s IN
    SELECT seq.relname AS seq_name, tbl.relname AS table_name, att.attname AS column_name, ps.last_value
    FROM pg_depend d
    JOIN pg_class seq ON seq.oid = d.objid AND seq.relkind = 'S'
    JOIN pg_class tbl ON tbl.oid = d.refobjid
    JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = d.refobjsubid
    JOIN pg_namespace n ON n.oid = seq.relnamespace AND n.nspname = 'public'
    JOIN pg_sequences ps ON ps.schemaname = n.nspname AND ps.sequencename = seq.relname
    WHERE d.deptype IN ('a', 'i')
  LOOP
    EXECUTE format('SELECT max(%I)::bigint FROM %I', s.column_name, s.table_name) INTO max_value;
    IF max_value IS NOT NULL AND (s.last_value IS NULL OR s.last_value < max_value) THEN
      RAISE WARNING 'sequence % is at % but %.% reaches %', s.seq_name, s.last_value, s.table_name, s.column_name, max_value;
      behind := behind + 1;
    END IF;
  END LOOP;
  RETURN behind;
END $$;
INSERT INTO verify_result
SELECT 'sequences: behind their column', behind, behind = 0 FROM (SELECT pg_temp.sequences_behind() AS behind) s;

INSERT INTO verify_result
SELECT 'sequences: Store.nextOrderNumber not past the last order', count(*), count(*) = 0
FROM "Store" s WHERE s."nextOrderNumber" <= COALESCE((SELECT max("orderNumber") FROM "Order"), 0);

-- Append-only and forbid-delete triggers: each refuses its operation on a real row. A table with no rows cannot be
-- probed; that is reported, not failed (a young database may have no disputes yet).
CREATE FUNCTION pg_temp.probe_append_only() RETURNS TABLE (probed bigint, accepted bigint, unprobed bigint)
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  op text;
  changed bigint;
BEGIN
  probed := 0; accepted := 0; unprobed := 0;
  FOR t IN
    SELECT c.relname AS table_name, tg.tgname, tg.tgtype
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT tg.tgisinternal
      AND (tg.tgname LIKE '%\_append\_only' OR tg.tgname LIKE '%\_forbid\_delete' OR tg.tgname LIKE '%\_forbid\_update')
    ORDER BY 1, 2
  LOOP
    EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM %I LIMIT 1) x', t.table_name) INTO changed;
    IF changed = 0 THEN
      unprobed := unprobed + 1;
      RAISE NOTICE 'not probed (no rows): % on %', t.tgname, t.table_name;
      CONTINUE;
    END IF;
    FOREACH op IN ARRAY ARRAY['UPDATE', 'DELETE'] LOOP
      CONTINUE WHEN (op = 'UPDATE' AND t.tgtype & 16 = 0) OR (op = 'DELETE' AND t.tgtype & 8 = 0);
      probed := probed + 1;
      BEGIN
        IF op = 'UPDATE' THEN
          EXECUTE format('UPDATE %I SET "id" = "id" WHERE ctid = (SELECT ctid FROM %I LIMIT 1)', t.table_name, t.table_name);
        ELSE
          EXECUTE format('DELETE FROM %I WHERE ctid = (SELECT ctid FROM %I LIMIT 1)', t.table_name, t.table_name);
        END IF;
        GET DIAGNOSTICS changed = ROW_COUNT;
        accepted := accepted + 1;
        RAISE WARNING '% on % was accepted (% row): trigger % does not enforce it', op, t.table_name, changed, t.tgname;
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%append-only%' AND SQLERRM NOT LIKE '%financial records%' THEN
          RAISE WARNING '% on % failed for another reason: %', op, t.table_name, SQLERRM;
          accepted := accepted + 1;
        END IF;
      END;
    END LOOP;
  END LOOP;
  RETURN NEXT;
END $$;
INSERT INTO verify_result
WITH p AS MATERIALIZED (SELECT * FROM pg_temp.probe_append_only())
SELECT 'append-only: operations probed', probed, probed > 0 FROM p
UNION ALL SELECT 'append-only: operations accepted (must be refused)', accepted, accepted = 0 FROM p
UNION ALL SELECT 'append-only: triggers on empty tables (not probed)', unprobed, true FROM p;

INSERT INTO verify_result
SELECT 'triggers: disabled', count(*), count(*) = 0
FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT tg.tgisinternal AND tg.tgenabled = 'D';

INSERT INTO verify_result
SELECT 'constraints: not validated', count(*), count(*) = 0
FROM pg_constraint co JOIN pg_namespace n ON n.oid = co.connamespace
WHERE n.nspname = 'public' AND NOT co.convalidated;

-- Information: the relay publishes these once a worker runs against the restored database.
INSERT INTO verify_result
SELECT 'outbox: unpublished events', count(*), true FROM "OutboxEvent" WHERE "publishedAt" IS NULL;
INSERT INTO verify_result
SELECT 'migrations: applied', count(*), true FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL;
INSERT INTO verify_result
SELECT 'migrations: failed or rolled back', count(*), count(*) = 0
FROM "_prisma_migrations" WHERE "finished_at" IS NULL OR "rolled_back_at" IS NOT NULL;

SELECT CASE WHEN ok THEN 'ok' ELSE 'FAIL' END AS result, value, name FROM verify_result ORDER BY name;
SELECT count(*) FILTER (WHERE NOT ok) > 0 AS verify_failed FROM verify_result \gset
ROLLBACK;

\if :verify_failed
DO $$ BEGIN RAISE EXCEPTION 'restore verification failed: see the FAIL rows above'; END $$;
\endif
