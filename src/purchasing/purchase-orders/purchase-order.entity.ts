import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { Currency, PurchaseOrderStatus } from '../../generated/prisma/client';
import { CurrencyEnum } from '../../products/enums/product.enum';
import { GraphQLDecimal } from '../../commons/money/decimal.scalar';
import { MoneyObject } from '../../commons/money/money.object';
import { COST_VIEWERS_ONLY } from '../cost/cost-visibility';

registerEnumType(PurchaseOrderStatus, {
  name: 'PurchaseOrderStatus',
  description: 'Where a purchase order stands (P4-E.1)',
  valuesMap: {
    DRAFT: { description: 'Being prepared; supplier, location and lines can change. Send or cancel it' },
    SENT: {
      description: 'Sent to the supplier; lines are frozen. Receive deliveries, or cancel while nothing arrived',
    },
    PARTIALLY_RECEIVED: { description: 'Some units arrived; receive the rest or close it short' },
    RECEIVED: { description: 'Every unit arrived' },
    CLOSED: { description: 'Closed short after a partial delivery; the outstanding units will not come' },
    CANCELLED: { description: 'Cancelled before anything arrived' },
  },
});

@ObjectType()
export class PurchaseOrderLine {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  variantId: string;

  @Field(() => Int)
  quantityOrdered: number;

  @Field(() => Int)
  quantityReceived: number;

  @Field(() => Int, { description: 'quantityOrdered - quantityReceived' })
  quantityOutstanding: number;

  @Field(() => GraphQLDecimal, {
    ...COST_VIEWERS_ONLY,
    description: 'Tax-exclusive cost of one unit, 4 dp (inventory.cost.view)',
  })
  unitCost: Decimal;

  @Field(() => MoneyObject, { ...COST_VIEWERS_ONLY, description: 'unitCost × quantityOrdered (inventory.cost.view)' })
  lineCost: Decimal;
}

@ObjectType()
export class PurchaseOrderReceiptLine {
  @Field(() => ID)
  id: string;

  @Field(() => ID, { description: 'The purchase order line received against' })
  lineId: string;

  @Field(() => ID)
  variantId: string;

  @Field(() => Int)
  quantity: number;

  @Field(() => GraphQLDecimal, { ...COST_VIEWERS_ONLY, description: 'Unit cost, 4 dp (inventory.cost.view)' })
  unitCost: Decimal;

  @Field(() => MoneyObject, { ...COST_VIEWERS_ONLY, description: 'unitCost × quantity (inventory.cost.view)' })
  cost: Decimal;

  @Field(() => ID, { nullable: true, description: 'The lot the units went into (lot-tracked variants)' })
  lotId: string | null;

  @Field(() => ID, { description: 'The (first) RECEIPT stock movement written for these units' })
  movementId: string;
}

@ObjectType({ description: 'One delivery received against a purchase order' })
export class PurchaseOrderReceipt {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  receivedById: string;

  @Field()
  receivedAt: Date;

  @Field(() => String, { nullable: true })
  note: string | null;

  @Field(() => [PurchaseOrderReceiptLine])
  lines: PurchaseOrderReceiptLine[];

  @Field(() => MoneyObject, {
    ...COST_VIEWERS_ONLY,
    description: 'Value of the delivery at cost (inventory.cost.view)',
  })
  cost: Decimal;
}

@ObjectType({ description: 'Goods ordered from a supplier for one stock location (staff with purchasing.view)' })
export class PurchaseOrder {
  @Field(() => ID)
  id: string;

  @Field(() => Int)
  number: number;

  @Field({ description: 'Human-readable and unique, e.g. PO-00042' })
  reference: string;

  @Field(() => ID)
  supplierId: string;

  @Field(() => ID, { description: 'Where the goods are received' })
  locationId: string;

  @Field(() => PurchaseOrderStatus)
  status: PurchaseOrderStatus;

  @Field(() => CurrencyEnum)
  currency: Currency;

  @Field(() => Date, { nullable: true })
  expectedAt: Date | null;

  @Field(() => String, { nullable: true })
  note: string | null;

  @Field(() => [PurchaseOrderLine])
  lines: PurchaseOrderLine[];

  @Field(() => [PurchaseOrderReceipt], { description: 'Deliveries, oldest first' })
  receipts: PurchaseOrderReceipt[];

  @Field(() => MoneyObject, { ...COST_VIEWERS_ONLY, description: 'Sum of the line costs (inventory.cost.view)' })
  totalCost: Decimal;

  @Field(() => MoneyObject, {
    ...COST_VIEWERS_ONLY,
    description: 'Value received so far at cost (inventory.cost.view)',
  })
  receivedCost: Decimal;

  @Field(() => ID)
  createdById: string;

  @Field(() => ID, { nullable: true })
  sentById: string | null;

  @Field(() => Date, { nullable: true })
  sentAt: Date | null;

  @Field(() => ID, { nullable: true })
  closedById: string | null;

  @Field(() => Date, { nullable: true })
  closedAt: Date | null;

  @Field(() => String, { nullable: true })
  closeReason: string | null;

  @Field(() => ID, { nullable: true })
  cancelledById: string | null;

  @Field(() => Date, { nullable: true })
  cancelledAt: Date | null;

  @Field(() => String, { nullable: true })
  cancelReason: string | null;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType()
export class PurchaseOrderPage {
  @Field(() => [PurchaseOrder])
  nodes: PurchaseOrder[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node id as `after` to read the next page' })
  hasNextPage: boolean;
}
