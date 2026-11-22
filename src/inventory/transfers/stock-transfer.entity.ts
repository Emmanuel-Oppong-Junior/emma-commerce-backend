import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { StockTransferStatus } from '../../generated/prisma/client';

registerEnumType(StockTransferStatus, {
  name: 'StockTransferStatus',
  description: 'Where a stock transfer between locations stands (P4-A.2)',
  valuesMap: {
    DRAFT: { description: 'Created; no stock has moved. Can be dispatched or cancelled' },
    DISPATCHED: { description: 'Stock has left the source and is in transit on the lines' },
    RECEIVED: { description: 'Every unit arrived at the destination' },
    PARTIALLY_RECEIVED: { description: 'Received with a shortfall on some lines, recorded as their variance' },
    CANCELLED: { description: 'Cancelled before dispatch; no stock moved' },
  },
});

@ObjectType()
export class StockTransferLine {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  variantId: string;

  @Field(() => Int, { description: 'Units dispatched (or to dispatch)' })
  quantity: number;

  @Field(() => Int, { nullable: true, description: 'Units that arrived; null until received' })
  receivedQuantity: number | null;

  @Field(() => String, { nullable: true, description: 'Why units are missing' })
  varianceNote: string | null;
}

@ObjectType({ description: 'Stock moved from one location to another in two steps: dispatch, then receipt (staff)' })
export class StockTransfer {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  fromLocationId: string;

  @Field(() => ID)
  toLocationId: string;

  @Field(() => StockTransferStatus)
  status: StockTransferStatus;

  @Field(() => String, { nullable: true })
  note: string | null;

  @Field(() => [StockTransferLine])
  lines: StockTransferLine[];

  @Field(() => ID)
  createdById: string;

  @Field(() => ID, { nullable: true })
  dispatchedById: string | null;

  @Field(() => Date, { nullable: true })
  dispatchedAt: Date | null;

  @Field(() => ID, { nullable: true })
  receivedById: string | null;

  @Field(() => Date, { nullable: true })
  receivedAt: Date | null;

  @Field(() => ID, { nullable: true })
  cancelledById: string | null;

  @Field(() => Date, { nullable: true })
  cancelledAt: Date | null;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType()
export class StockTransferPage {
  @Field(() => [StockTransfer])
  nodes: StockTransfer[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node id as `after` to read the next page' })
  hasNextPage: boolean;
}

@ObjectType({ description: 'Units of a variant dispatched and not yet received, over every open transfer' })
export class VariantInTransit {
  @Field(() => ID)
  variantId: string;

  @Field(() => Int)
  quantity: number;
}
