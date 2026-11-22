import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { StockMovementReason } from '../../generated/prisma/client';

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
    ADJUSTMENT: { description: 'Manual correction with a reason (damage, loss, stock count)' },
    TRANSFER: {
      description:
        'Moved between locations: negative at the source on dispatch, positive at the destination on receipt',
    },
    RESERVE: { description: 'Units held for an order line; on hand, no longer available' },
    RELEASE: { description: 'A hold given back because the order was cancelled or expired' },
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

  @Field(() => String, { nullable: true, description: 'What caused it: Order, ReturnRequest, InventoryLog, ...' })
  refType: string | null;

  @Field(() => ID, { nullable: true })
  refId: string | null;

  @Field(() => ID, { nullable: true, description: 'The staff member or customer who caused it' })
  actorId: string | null;

  @Field(() => String, { nullable: true })
  note: string | null;

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
