-- Restore-drill dataset (P9-D). Runs after `prisma migrate deploy` and `prisma db seed` on a THROWAWAY database and adds
-- what the seed lacks: customers, staff, orders in every state with their payment ledger, refunds, a return, a
-- dispute, COD cash and a remittance, shipments with proof of delivery, lot- and serial-tracked stock received on
-- purchase orders, loyalty, consent and unpublished outbox events. Rows are written directly, never through the app, so
-- the helpers below keep the ledger invariants by construction (every stock change is a StockMovement plus the same
-- delta on StockLevel/LotStock); the drill's verify.sql checks them on the source before trusting the restore.
--
--   psql -v ON_ERROR_STOP=1 -v orders=400 -f fixture.sql
\set ON_ERROR_STOP on
SET drill.orders = :'orders';

BEGIN;

CREATE FUNCTION pg_temp.id(prefix text) RETURNS text LANGUAGE sql AS $$
  SELECT prefix || '_' || replace(gen_random_uuid()::text, '-', '')
$$;

-- One stock change: an append-only movement plus the same delta on the level (and on the lot, for a lot movement).
CREATE FUNCTION pg_temp.move(variant text, location text, on_hand_delta int, reserved_delta int, reason text, ref_type text,
                             ref_id text, lot text DEFAULT NULL, unit_cost numeric DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE movement text := pg_temp.id('mv');
BEGIN
  INSERT INTO "StockMovement" ("id", "variantId", "locationId", "onHandDelta", "reservedDelta", "reason", "refType",
                               "refId", "lotId", "unitCost")
  VALUES (movement, variant, location, on_hand_delta, reserved_delta, reason::"StockMovementReason", ref_type, ref_id, lot, unit_cost);
  -- Update first: INSERT ... ON CONFLICT checks the CHECKs on the would-be new row (a reserve alone breaks them).
  UPDATE "StockLevel" SET "onHand" = "onHand" + on_hand_delta, "reserved" = "reserved" + reserved_delta, "updatedAt" = now()
  WHERE "variantId" = variant AND "locationId" = location;
  IF NOT FOUND THEN
    INSERT INTO "StockLevel" ("id", "variantId", "locationId", "onHand", "reserved", "updatedAt")
    VALUES (pg_temp.id('sl'), variant, location, on_hand_delta, reserved_delta, now());
  END IF;
  IF lot IS NOT NULL THEN
    UPDATE "LotStock" SET "onHand" = "onHand" + on_hand_delta, "updatedAt" = now()
    WHERE "lotId" = lot AND "locationId" = location;
    IF NOT FOUND THEN
      INSERT INTO "LotStock" ("id", "lotId", "locationId", "onHand", "updatedAt")
      VALUES (pg_temp.id('ls'), lot, location, on_hand_delta, now());
    END IF;
  END IF;
  RETURN movement;
END $$;

CREATE FUNCTION pg_temp.order_event(ord text, from_status text, to_status text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO "OrderStatusEvent" ("id", "orderId", "from", "to")
  VALUES (pg_temp.id('ose'), ord, from_status::"OrderStatus", to_status::"OrderStatus");
  UPDATE "Order" SET "status" = to_status::"OrderStatus", "updatedAt" = now() WHERE "id" = ord;
$$;

CREATE FUNCTION pg_temp.outbox(event_type text, aggregate text, published boolean) RETURNS void LANGUAGE sql AS $$
  INSERT INTO "OutboxEvent" ("id", "type", "aggregateId", "payload", "publishedAt")
  VALUES (pg_temp.id('ob'), event_type, aggregate, jsonb_build_object('orderId', aggregate),
          CASE WHEN published THEN now() END);
$$;

-- A placed order of one line: totals snapshot, ACTIVE reservation, pending payment intent and attempt.
CREATE FUNCTION pg_temp.place(customer text, variant text, qty int, method text, location text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  ord text := pg_temp.id('ord');
  item text := pg_temp.id('oi');
  intent text := pg_temp.id('pi');
  number int;
  unit numeric;
  product text;
  product_name text;
  variant_sku text;
  email text;
  phone text;
BEGIN
  UPDATE "Store" SET "nextOrderNumber" = "nextOrderNumber" + 1, "updatedAt" = now()
  RETURNING "nextOrderNumber" - 1 INTO number;
  SELECT v."price", v."productId", p."name", v."sku" INTO unit, product, product_name, variant_sku
  FROM "Variant" v JOIN "Product" p ON p."id" = v."productId" WHERE v."id" = variant;
  SELECT u."email", u."phoneNumber" INTO email, phone FROM "User" u WHERE u."id" = customer;
  INSERT INTO "Order" ("id", "orderNumber", "userId", "currency", "pricingVersion", "subtotal", "discountTotal",
                       "taxTotal", "shippingTotal", "grandTotal", "paymentMethod", "contactEmail", "contactPhone",
                       "stockLocationId", "serviceLevel", "shippingFee", "updatedAt")
  VALUES (ord, number, customer, 'GHS', 5, unit * qty, 0, 0, 20, unit * qty + 20, method::"PaymentMethod", email, phone,
          location, 'STANDARD', 20, now());
  INSERT INTO "OrderItem" ("id", "orderId", "productId", "variantId", "productName", "sku", "quantity", "unitListPrice",
                           "unitDiscount", "unitNet", "unitTax", "lineTotal")
  VALUES (item, ord, product, variant, product_name, variant_sku, qty, unit, 0, unit, 0, unit * qty);
  INSERT INTO "StockReservation" ("id", "variantId", "locationId", "orderId", "orderItemId", "quantity", "updatedAt")
  VALUES (pg_temp.id('sr'), variant, location, ord, item, qty, now());
  PERFORM pg_temp.move(variant, location, 0, qty, 'RESERVE', 'Order', ord);
  INSERT INTO "OrderStatusEvent" ("id", "orderId", "to") VALUES (pg_temp.id('ose'), ord, 'PLACED');
  INSERT INTO "PaymentIntent" ("id", "orderId", "amount", "updatedAt") VALUES (intent, ord, unit * qty + 20, now());
  INSERT INTO "PaymentAttempt" ("id", "intentId", "provider", "reference", "amount", "channel", "updatedAt")
  VALUES (pg_temp.id('pa'), intent, CASE WHEN method = 'ONLINE' THEN 'PAYSTACK' ELSE 'CASH_ON_DELIVERY' END::"PaymentProvider",
          CASE WHEN method = 'ONLINE' THEN 'DRILL-' || number END, unit * qty + 20,
          CASE WHEN method = 'ONLINE' THEN 'card' ELSE 'cash' END, now());
  PERFORM pg_temp.outbox('order.placed.v1', ord, true);
  RETURN ord;
END $$;

-- The order's reserved units leave the shelf (online payment success, or COD dispatch); lot-tracked lines name a lot.
CREATE FUNCTION pg_temp.consume(ord text, lot text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM "StockReservation" WHERE "orderId" = ord AND "status" = 'ACTIVE' LOOP
    UPDATE "StockReservation" SET "status" = 'CONSUMED', "updatedAt" = now() WHERE "id" = r."id";
    PERFORM pg_temp.move(r."variantId", r."locationId", -r."quantity", -r."quantity", 'SALE', 'Order', ord, lot);
  END LOOP;
END $$;

CREATE FUNCTION pg_temp.capture(ord text) RETURNS void LANGUAGE sql AS $$
  UPDATE "PaymentAttempt" a SET "status" = 'CAPTURED', "rawStatus" = 'success', "updatedAt" = now()
  FROM "PaymentIntent" i WHERE i."id" = a."intentId" AND i."orderId" = ord;
  UPDATE "PaymentIntent" SET "status" = 'CAPTURED', "updatedAt" = now() WHERE "orderId" = ord;
  SELECT pg_temp.outbox('payment.succeeded.v1', ord, true);
$$;

CREATE FUNCTION pg_temp.pay_online(ord text, lot text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  SELECT pg_temp.capture(ord);
  SELECT pg_temp.consume(ord, lot);
  SELECT pg_temp.order_event(ord, 'PLACED', 'CONFIRMED');
$$;

CREATE FUNCTION pg_temp.close_unpaid(ord text, to_status text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM "StockReservation" WHERE "orderId" = ord AND "status" = 'ACTIVE' LOOP
    UPDATE "StockReservation" SET "status" = 'RELEASED', "updatedAt" = now() WHERE "id" = r."id";
    PERFORM pg_temp.move(r."variantId", r."locationId", 0, -r."quantity", 'RELEASE', 'Order', ord);
  END LOOP;
  UPDATE "PaymentAttempt" a SET "status" = 'CANCELLED', "updatedAt" = now()
  FROM "PaymentIntent" i WHERE i."id" = a."intentId" AND i."orderId" = ord;
  UPDATE "PaymentIntent" SET "status" = 'CANCELLED', "updatedAt" = now() WHERE "orderId" = ord;
  PERFORM pg_temp.order_event(ord, 'PLACED', to_status);
END $$;

-- One shipment carrying the whole order, moved to `final_status`.
CREATE FUNCTION pg_temp.ship(ord text, final_status text, rider text DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  shipment text := pg_temp.id('sh');
  left_shop boolean := final_status IN ('OUT_FOR_DELIVERY', 'DELIVERED');
BEGIN
  INSERT INTO "Shipment" ("id", "orderId", "status", "carrier", "dispatchedAt", "deliveredAt", "riderId", "assignedAt",
                          "updatedAt")
  VALUES (shipment, ord, final_status::"ShipmentStatus", 'Own fleet', CASE WHEN left_shop THEN now() END,
          CASE WHEN final_status = 'DELIVERED' THEN now() END, rider, CASE WHEN rider IS NOT NULL THEN now() END, now());
  INSERT INTO "ShipmentItem" ("id", "shipmentId", "orderItemId", "quantity")
  SELECT pg_temp.id('si'), shipment, oi."id", oi."quantity" FROM "OrderItem" oi WHERE oi."orderId" = ord;
  INSERT INTO "ShipmentStatusEvent" ("id", "shipmentId", "to") VALUES (pg_temp.id('sse'), shipment, final_status::"ShipmentStatus");
  IF left_shop THEN
    PERFORM pg_temp.outbox('shipment.status_changed.v1', ord, true);
  END IF;
  RETURN shipment;
END $$;

CREATE FUNCTION pg_temp.refund(ord text, qty int, reason text, return_request text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  refund text := pg_temp.id('rf');
  attempt text;
  item record;
  captured numeric;
  refunded numeric;
BEGIN
  SELECT a."id", a."amount" INTO attempt, captured FROM "PaymentAttempt" a JOIN "PaymentIntent" i ON i."id" = a."intentId"
  WHERE i."orderId" = ord AND a."status" = 'CAPTURED';
  SELECT * INTO item FROM "OrderItem" WHERE "orderId" = ord LIMIT 1;
  INSERT INTO "Refund" ("id", "attemptId", "returnRequestId", "amount", "taxAmount", "status", "providerRef",
                        "idempotencyKey", "reason", "method", "updatedAt")
  VALUES (refund, attempt, return_request, item."unitNet" * qty, 0, 'PROCESSED', 'RFD-' || refund, 'staff:' || refund,
          reason::"RefundReason", 'PROVIDER', now());
  INSERT INTO "RefundLine" ("id", "refundId", "orderItemId", "quantity", "amount")
  VALUES (pg_temp.id('rl'), refund, item."id", qty, item."unitNet" * qty);
  SELECT COALESCE(sum(r."amount"), 0) INTO refunded FROM "Refund" r WHERE r."attemptId" = attempt AND r."status" = 'PROCESSED';
  UPDATE "PaymentIntent" SET "status" = CASE WHEN refunded >= captured THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END::"PaymentIntentStatus",
                             "updatedAt" = now()
  WHERE "orderId" = ord;
  PERFORM pg_temp.outbox('refund.succeeded.v1', ord, true);
END $$;

DO $$
DECLARE
  store_id text;
  main_loc text;
  branch_loc text;
  owner_id text := pg_temp.id('usr');
  rider_id text := pg_temp.id('usr');
  customers text[] := '{}';
  stocked text[];
  orders int := current_setting('drill.orders')::int;
  ord text;
  shipment text;
  remittance text := pg_temp.id('crm');
  remitted numeric := 0;
  collection record;
  c int;
  i int;
  -- lot- and serial-tracked catalogue
  lot_product text := pg_temp.id('prd');
  lot_variant text := pg_temp.id('var');
  lot_early text := pg_temp.id('lot');
  lot_late text := pg_temp.id('lot');
  serial_product text := pg_temp.id('prd');
  serial_variant text := pg_temp.id('var');
  supplier text := pg_temp.id('sup');
  po text := pg_temp.id('po');
  po_lot_line text := pg_temp.id('pol');
  po_serial_line text := pg_temp.id('pol');
  receipt text := pg_temp.id('por');
  movement text;
  unit text;
  item text;
  ret text;
  dispute text;
  earn text;
BEGIN
  SELECT "id" INTO STRICT store_id FROM "Store" WHERE "singleton";
  SELECT "id" INTO STRICT main_loc FROM "StockLocation" WHERE "isDefault";

  branch_loc := pg_temp.id('loc');
  INSERT INTO "StockLocation" ("id", "storeId", "name", "type", "updatedAt")
  VALUES (branch_loc, store_id, 'Kumasi branch', 'BRANCH', now());

  -- People: an Owner, a rider and customers with verified phones.
  INSERT INTO "User" ("id", "email", "name", "role", "updatedAt", "mfaEnabledAt")
  VALUES (owner_id, 'drill-owner@example.test', 'Drill Owner', 'SUPER_ADMIN', now(), now());
  INSERT INTO "User" ("id", "email", "name", "role", "phoneNumber", "updatedAt")
  VALUES (rider_id, 'drill-rider@example.test', 'Drill Rider', 'USER', '+233200000001', now());
  INSERT INTO "StoreMembership" ("id", "userId", "storeId", "roleId", "updatedAt")
  SELECT pg_temp.id('sm'), u, store_id, r."id", now()
  FROM (VALUES (owner_id, 'OWNER'), (rider_id, 'RIDER')) AS m(u, k) JOIN "StaffRole" r ON r."key" = m.k;
  FOR c IN 1..25 LOOP
    customers := customers || pg_temp.id('usr');
    INSERT INTO "User" ("id", "email", "name", "phoneNumber", "phoneVerifiedAt", "phoneVerifiedNumber", "updatedAt")
    VALUES (customers[c], 'drill-customer-' || c || '@example.test', 'Customer ' || c,
            '+2332410' || lpad(c::text, 5, '0'), now(), '+2332410' || lpad(c::text, 5, '0'), now());
  END LOOP;

  -- Seeded variants with enough stock for every order the loop places.
  SELECT array_agg("variantId" ORDER BY "variantId") INTO stocked
  FROM "StockLevel" WHERE "locationId" = main_loc AND "onHand" >= 100;
  IF coalesce(array_length(stocked, 1), 0) < 20 THEN
    RAISE EXCEPTION 'fixture needs the seeded catalogue: only % variants with stock', coalesce(array_length(stocked, 1), 0);
  END IF;
  -- Top the main location up so a large --orders run never sells a variant out.
  FOREACH unit IN ARRAY stocked LOOP
    PERFORM pg_temp.move(unit, main_loc, 3 * orders / array_length(stocked, 1) + 3, 0, 'RECEIPT', NULL, NULL);
  END LOOP;
  -- Some stock at the branch, moved there by receipt (transfers are not part of the drill data).
  FOR i IN 1..10 LOOP
    PERFORM pg_temp.move(stocked[i], branch_loc, 40 + orders, 0, 'RECEIPT', NULL, NULL);
  END LOOP;

  -- Orders in every state, cycling through the online and cash-on-delivery paths.
  FOR i IN 1..orders LOOP
    -- Every tenth order is served from the branch, from the variants stocked there.
    ord := pg_temp.place(customers[1 + i % 25],
                         CASE WHEN i % 10 = 0 THEN stocked[1 + (i / 10) % 10] ELSE stocked[1 + i % array_length(stocked, 1)] END,
                         1 + i % 3, CASE WHEN i % 8 = 7 THEN 'CASH_ON_DELIVERY' ELSE 'ONLINE' END,
                         CASE WHEN i % 10 = 0 THEN branch_loc ELSE main_loc END);
    CASE i % 8
      WHEN 0 THEN NULL; -- PLACED, awaiting payment
      WHEN 1 THEN PERFORM pg_temp.pay_online(ord);
      WHEN 2 THEN
        PERFORM pg_temp.pay_online(ord);
        PERFORM pg_temp.ship(ord, 'PACKED');
        PERFORM pg_temp.order_event(ord, 'CONFIRMED', 'IN_FULFILMENT');
      WHEN 3, 4 THEN
        PERFORM pg_temp.pay_online(ord);
        PERFORM pg_temp.ship(ord, 'DELIVERED');
        PERFORM pg_temp.order_event(ord, 'CONFIRMED', 'IN_FULFILMENT');
        PERFORM pg_temp.order_event(ord, 'IN_FULFILMENT', 'COMPLETED');
        IF i % 8 = 4 THEN PERFORM pg_temp.refund(ord, 1, 'DAMAGED'); END IF;
      WHEN 5 THEN PERFORM pg_temp.close_unpaid(ord, 'CANCELLED');
      WHEN 6 THEN PERFORM pg_temp.close_unpaid(ord, 'EXPIRED');
      WHEN 7 THEN
        -- COD: the rider takes it out (stock consumed at dispatch), proves delivery with the code and collects cash.
        PERFORM pg_temp.order_event(ord, 'PLACED', 'CONFIRMED');
        shipment := pg_temp.ship(ord, 'DELIVERED', rider_id);
        PERFORM pg_temp.consume(ord);
        PERFORM pg_temp.order_event(ord, 'CONFIRMED', 'IN_FULFILMENT');
        INSERT INTO "ProofOfDelivery" ("id", "shipmentId", "method", "deliveredById", "deliveredAt", "recipientName")
        VALUES (pg_temp.id('pod'), shipment, 'CODE', rider_id, now(), 'Recipient');
        PERFORM pg_temp.capture(ord);
        INSERT INTO "CashCollection" ("id", "orderId", "attemptId", "riderId", "recordedById", "amount", "collectedAt")
        SELECT pg_temp.id('cc'), ord, a."id", rider_id, rider_id, a."amount", now()
        FROM "PaymentAttempt" a JOIN "PaymentIntent" p ON p."id" = a."intentId" WHERE p."orderId" = ord;
        PERFORM pg_temp.order_event(ord, 'IN_FULFILMENT', 'COMPLETED');
    END CASE;
  END LOOP;

  -- The rider hands in the cash of every collection but the latest two.
  SELECT COALESCE(sum("amount"), 0) INTO remitted FROM (
    SELECT "amount" FROM "CashCollection" ORDER BY "collectedAt", "id" OFFSET 2
  ) t;
  IF remitted > 0 THEN
    INSERT INTO "CashRemittance" ("id", "riderId", "receivedById", "amount", "expectedAmount", "discrepancy", "currency",
                                  "receivedAt")
    VALUES (remittance, rider_id, owner_id, remitted, remitted, 0, 'GHS', now());
    UPDATE "CashCollection" SET "remittanceId" = remittance
    WHERE "id" IN (SELECT "id" FROM "CashCollection" ORDER BY "collectedAt", "id" OFFSET 2);
  END IF;

  -- The latest placed orders' events are still waiting for the relay: a restore must keep them.
  UPDATE "OutboxEvent" SET "publishedAt" = NULL
  WHERE "id" IN (SELECT "id" FROM "OutboxEvent" WHERE "type" = 'order.placed.v1' ORDER BY "createdAt" DESC, "id" LIMIT 3);

  -- Lot- and serial-tracked products, received on a purchase order with weighted-average cost.
  INSERT INTO "Product" ("id", "name", "trackLots", "isPerishable", "updatedAt")
  VALUES (lot_product, 'Drill Paracetamol 500mg', true, true, now());
  INSERT INTO "Variant" ("id", "productId", "sku", "price", "basePrice", "updatedAt")
  VALUES (lot_variant, lot_product, 'DRILL-LOT-1', 12.50, 12.50, now());
  INSERT INTO "Product" ("id", "name", "trackSerials", "serialFormat", "warrantyMonths", "updatedAt")
  VALUES (serial_product, 'Drill Phone X', true, 'IMEI', 12, now());
  INSERT INTO "Variant" ("id", "productId", "sku", "price", "basePrice", "updatedAt")
  VALUES (serial_variant, serial_product, 'DRILL-SER-1', 2500, 2500, now());
  INSERT INTO "PriceChange" ("id", "variantId", "field", "newValue", "currency", "source")
  SELECT pg_temp.id('pc'), v, f::"PriceChangeField", p, 'GHS', 'VARIANT_CREATED'
  FROM (VALUES (lot_variant, 12.50), (serial_variant, 2500)) AS x(v, p), (VALUES ('BASE_PRICE'), ('PRICE')) AS y(f);
  INSERT INTO "Lot" ("id", "variantId", "lotNumber", "expiresAt") VALUES
    (lot_early, lot_variant, 'LOT-A', now() + interval '90 days'),
    (lot_late, lot_variant, 'LOT-B', now() + interval '400 days');

  INSERT INTO "Supplier" ("id", "storeId", "name", "nameKey", "currency", "updatedAt")
  VALUES (supplier, store_id, 'Accra Wholesale', 'accra wholesale', 'GHS', now());
  INSERT INTO "PurchaseOrder" ("id", "supplierId", "locationId", "status", "currency", "createdById", "sentById", "sentAt",
                               "updatedAt")
  VALUES (po, supplier, main_loc, 'RECEIVED', 'GHS', owner_id, owner_id, now(), now());
  INSERT INTO "PurchaseOrderLine" ("id", "purchaseOrderId", "variantId", "quantityOrdered", "unitCost", "quantityReceived")
  VALUES (po_lot_line, po, lot_variant, 50, 4.2, 50), (po_serial_line, po, serial_variant, 6, 1800, 6);
  INSERT INTO "PurchaseOrderReceipt" ("id", "purchaseOrderId", "receivedById") VALUES (receipt, po, owner_id);
  movement := pg_temp.move(lot_variant, main_loc, 30, 0, 'RECEIPT', 'PurchaseOrder', po, lot_early, 4.2);
  INSERT INTO "PurchaseOrderReceiptLine" ("id", "receiptId", "lineId", "quantity", "unitCost", "lotId", "movementId")
  VALUES (pg_temp.id('prl'), receipt, po_lot_line, 30, 4.2, lot_early, movement);
  movement := pg_temp.move(lot_variant, main_loc, 20, 0, 'RECEIPT', 'PurchaseOrder', po, lot_late, 4.2);
  movement := pg_temp.move(serial_variant, main_loc, 6, 0, 'RECEIPT', 'PurchaseOrder', po, NULL, 1800);
  INSERT INTO "PurchaseOrderReceiptLine" ("id", "receiptId", "lineId", "quantity", "unitCost", "movementId")
  VALUES (pg_temp.id('prl'), receipt, po_serial_line, 6, 1800, movement);
  FOR i IN 1..6 LOOP
    unit := pg_temp.id('su');
    INSERT INTO "SerialUnit" ("id", "variantId", "serial", "locationId", "updatedAt")
    VALUES (unit, serial_variant, '35000000000000' || i, main_loc, now());
    INSERT INTO "SerialUnitEvent" ("id", "serialUnitId", "to", "locationId", "movementId", "refType", "refId")
    VALUES (pg_temp.id('sue'), unit, 'IN_STOCK', main_loc, movement, 'PurchaseOrder', po);
  END LOOP;
  UPDATE "Variant" SET "costPrice" = CASE "id" WHEN lot_variant THEN 4.2 ELSE 1800 END
  WHERE "id" IN (lot_variant, serial_variant);
  INSERT INTO "CostChange" ("id", "variantId", "newValue", "currency", "source", "refType", "refId")
  VALUES (pg_temp.id('cch'), lot_variant, 4.2, 'GHS', 'PURCHASE_ORDER', 'PurchaseOrderReceipt', receipt),
         (pg_temp.id('cch'), serial_variant, 1800, 'GHS', 'PURCHASE_ORDER', 'PurchaseOrderReceipt', receipt);
  -- Two more purchase orders so the PO number sequence has moved past 1.
  INSERT INTO "PurchaseOrder" ("id", "supplierId", "locationId", "status", "currency", "createdById", "sentById", "sentAt",
                               "updatedAt")
  VALUES (pg_temp.id('po'), supplier, main_loc, 'SENT', 'GHS', owner_id, owner_id, now(), now()),
         (pg_temp.id('po'), supplier, branch_loc, 'DRAFT', 'GHS', owner_id, NULL, NULL, now());

  -- A lot-tracked sale drawn from the earliest-expiring lot.
  ord := pg_temp.place(customers[1], lot_variant, 4, 'ONLINE', main_loc);
  PERFORM pg_temp.pay_online(ord, lot_early);

  -- Serial units: one sold and delivered (warranty running), one assigned to a packed shipment.
  ord := pg_temp.place(customers[2], serial_variant, 1, 'ONLINE', main_loc);
  PERFORM pg_temp.pay_online(ord);
  shipment := pg_temp.ship(ord, 'DELIVERED');
  PERFORM pg_temp.order_event(ord, 'CONFIRMED', 'IN_FULFILMENT');
  PERFORM pg_temp.order_event(ord, 'IN_FULFILMENT', 'COMPLETED');
  SELECT "id" INTO unit FROM "SerialUnit" WHERE "variantId" = serial_variant ORDER BY "serial" LIMIT 1;
  SELECT oi."id", si."id" INTO item, movement FROM "OrderItem" oi JOIN "ShipmentItem" si ON si."orderItemId" = oi."id"
  WHERE oi."orderId" = ord;
  UPDATE "SerialUnit" SET "status" = 'SOLD', "locationId" = NULL, "orderItemId" = item, "shipmentItemId" = movement,
                          "soldAt" = now(), "warrantyStartsAt" = now(), "warrantyEndsAt" = now() + interval '12 months',
                          "updatedAt" = now()
  WHERE "id" = unit;
  INSERT INTO "SerialUnitEvent" ("id", "serialUnitId", "from", "to", "orderItemId", "refType", "refId") VALUES
    (pg_temp.id('sue'), unit, 'IN_STOCK', 'ASSIGNED', item, 'Order', ord),
    (pg_temp.id('sue'), unit, 'ASSIGNED', 'SOLD', item, 'Order', ord);

  ord := pg_temp.place(customers[3], serial_variant, 1, 'ONLINE', main_loc);
  PERFORM pg_temp.pay_online(ord);
  PERFORM pg_temp.ship(ord, 'PACKED');
  PERFORM pg_temp.order_event(ord, 'CONFIRMED', 'IN_FULFILMENT');
  SELECT "id" INTO unit FROM "SerialUnit" WHERE "variantId" = serial_variant AND "status" = 'IN_STOCK' ORDER BY "serial" LIMIT 1;
  SELECT oi."id", si."id" INTO item, movement FROM "OrderItem" oi JOIN "ShipmentItem" si ON si."orderItemId" = oi."id"
  WHERE oi."orderId" = ord;
  UPDATE "SerialUnit" SET "status" = 'ASSIGNED', "orderItemId" = item, "shipmentItemId" = movement, "updatedAt" = now()
  WHERE "id" = unit;
  INSERT INTO "SerialUnitEvent" ("id", "serialUnitId", "from", "to", "locationId", "orderItemId", "refType", "refId")
  VALUES (pg_temp.id('sue'), unit, 'IN_STOCK', 'ASSIGNED', main_loc, item, 'Order', ord);

  -- A return refunded through its request, and a dispute with evidence, on delivered online orders.
  ord := pg_temp.place(customers[4], stocked[1], 2, 'ONLINE', main_loc);
  PERFORM pg_temp.pay_online(ord);
  PERFORM pg_temp.ship(ord, 'DELIVERED');
  PERFORM pg_temp.order_event(ord, 'CONFIRMED', 'IN_FULFILMENT');
  PERFORM pg_temp.order_event(ord, 'IN_FULFILMENT', 'COMPLETED');
  ret := pg_temp.id('rr');
  INSERT INTO "ReturnRequest" ("id", "orderId", "userId", "reason", "status", "refundAmount", "updatedAt")
  SELECT ret, ord, customers[4], 'Wrong colour', 'REFUNDED', oi."unitNet", now() FROM "OrderItem" oi WHERE oi."orderId" = ord;
  INSERT INTO "ReturnStatusEvent" ("id", "returnRequestId", "from", "to", "actorId") VALUES
    (pg_temp.id('rse'), ret, NULL, 'REQUESTED', customers[4]),
    (pg_temp.id('rse'), ret, 'REQUESTED', 'APPROVED', owner_id),
    (pg_temp.id('rse'), ret, 'APPROVED', 'REFUNDED', owner_id);
  PERFORM pg_temp.refund(ord, 1, 'RETURN', ret);

  ord := pg_temp.place(customers[5], stocked[2], 1, 'ONLINE', main_loc);
  PERFORM pg_temp.pay_online(ord);
  dispute := pg_temp.id('dsp');
  INSERT INTO "Dispute" ("id", "attemptId", "orderId", "provider", "providerDisputeId", "amount", "currency", "status",
                         "source", "createdById", "updatedAt")
  SELECT dispute, a."id", ord, 'PAYSTACK', 'DRILL-DSP-1', a."amount", 'GHS', 'AWAITING_EVIDENCE', 'STAFF', owner_id, now()
  FROM "PaymentAttempt" a JOIN "PaymentIntent" p ON p."id" = a."intentId" WHERE p."orderId" = ord;
  INSERT INTO "DisputeEvent" ("id", "disputeId", "fromStatus", "toStatus", "source", "actorId") VALUES
    (pg_temp.id('dse'), dispute, NULL, 'OPEN', 'STAFF', owner_id),
    (pg_temp.id('dse'), dispute, 'OPEN', 'AWAITING_EVIDENCE', 'STAFF', owner_id);
  INSERT INTO "DisputeNote" ("id", "disputeId", "authorId", "body")
  VALUES (pg_temp.id('dsn'), dispute, owner_id, 'Courier signature attached');
  PERFORM pg_temp.outbox('payment.dispute_opened.v1', ord, true);

  -- Loyalty points earned on a completed order, and a marketing consent.
  SELECT o."id" INTO ord FROM "Order" o WHERE o."userId" = customers[4] AND o."status" = 'COMPLETED' ORDER BY o."orderNumber" LIMIT 1;
  earn := pg_temp.id('ltx');
  INSERT INTO "LoyaltyAccount" ("userId", "balance", "updatedAt") VALUES (customers[4], 50, now());
  INSERT INTO "LoyaltyTransaction" ("id", "userId", "type", "points", "orderId") VALUES (earn, customers[4], 'EARN', 50, ord);
  INSERT INTO "LoyaltyLot" ("id", "userId", "transactionId", "points", "remaining", "expiresAt")
  VALUES (pg_temp.id('llt'), customers[4], earn, 50, 50, now() + interval '12 months');
  INSERT INTO "ConsentEvent" ("id", "userId", "category", "channel", "action", "source")
  SELECT pg_temp.id('cev'), u, 'MARKETING', 'EMAIL', 'GRANTED', 'CHECKOUT' FROM unnest(customers[1:5]) AS u;
END $$;

COMMIT;

-- Fresh statistics, as a live database has: the checks plan badly on tables the planner has never measured.
ANALYZE;
