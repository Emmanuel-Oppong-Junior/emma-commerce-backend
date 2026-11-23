import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { StockAdjustmentReason, StockMovementReason } from '../../generated/prisma/client';
import { GraphQLDecimal } from '../../commons/money/decimal.scalar';
import { COST_VIEWERS_ONLY } from '../../purchasing/cost/cost-visibility';

registerEnumType(StockMovementReason, {
  name: 'StockMovementReason',
  description: 'Why stock moved (ADR-0008)',
  valuesMap: {
    OPENING_BALANCE: { description: 'Stock the old inventory log did not explain, recorded by the ledger migration' },
    RECEIPT: { description: 'Stock received: a delivery, or the opening stock of a new variant' },
    SALE: { description: 'A reservation consumed: online payment captured, or a cash-on-delivery order dispatched' },
    RETURN_RESTOCK: {
      description: 'Goods back on hand: a return restocked, or a paid order cancelled before dispatch',
    },
    ADJUSTMENT: { description: 'Manual change with an adjustmentReason, or a stock-take variance (STOCK_TAKE)' },
    TRANSFER: {
      description:
        'Moved between locations: negative at the source on dispatch, positive at the destination on receipt',
    },
    RESERVE: { description: 'Units held for an order line; on hand, no longer available' },
    RELEASE: { description: 'A hold given back because the order was cancelled or expired' },
  },
});

registerEnumType(StockAdjustmentReason, {
  name: 'StockAdjustmentReason',
  description: 'Why staff adjusted stock (an ADJUSTMENT movement)',
  valuesMap: {
    DAMAGED: { description: 'Damaged goods written off (removes stock)' },
    LOST: { description: 'Missing or stolen goods (removes stock)' },
    FOUND: { description: 'Goods found that were not on the books (adds stock)' },
    EXPIRED: { description: 'Expired goods written off (removes stock)' },
    CORRECTION: { description: 'A correction of an earlier mistake (either way)' },
    STOCK_TAKE: { description: 'The variance of an approved stock-take; never given by hand' },
    OTHER: { description: 'Anything else; a note is required' },
  },
});

@ObjectType({ description: 'One entry of the append-only stock ledger' })
export class StockMovement {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  variantId: string;

  @Field(() => ID)
  locationId: string;

  @Field(() => Int, { description: 'Signed change to on-hand stock' })
  onHandDelta: number;

  @Field(() => Int, { description: 'Signed change to reserved stock' })
  reservedDelta: number;

  @Field(() => StockMovementReason)
  reason: StockMovementReason;

  @Field(() => StockAdjustmentReason, {
    nullable: true,
    description: 'Why staff adjusted: set on ADJUSTMENT movements recorded since P4-B.1, null otherwise',
  })
  adjustmentReason: StockAdjustmentReason | null;

  @Field(() => String, { nullable: true, description: 'What caused it: Order, ReturnRequest, InventoryLog, ...' })
  refType: string | null;

  @Field(() => ID, { nullable: true })
  refId: string | null;

  @Field(() => ID, { nullable: true, description: 'The staff member or customer who caused it' })
  actorId: string | null;

  @Field(() => String, { nullable: true })
  note: string | null;

  @Field(() => ID, {
    nullable: true,
    description: 'The lot moved (lot-tracked variants, P4-C.1): one movement per lot',
  })
  lotId: string | null;

  @Field(() => GraphQLDecimal, {
    ...COST_VIEWERS_ONLY,
    description: 'Unit cost, 4 dp: RECEIPT movements of a purchase-order receipt only (inventory.cost.view)',
  })
  unitCost: Decimal | null;

  @Field()
  createdAt: Date;
}

@ObjectType()
export class StockMovementPage {
  @Field(() => [StockMovement])
  nodes: StockMovement[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node id as `after` to read the next page' })
  hasNextPage: boolean;
}
