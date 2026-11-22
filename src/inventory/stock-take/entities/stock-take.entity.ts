import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { StockTakeStatus } from '../../../generated/prisma/client';
import { MoneyObject } from '../../../commons/money/money.object';
import { staffWith } from '../../../iam/authorization/staff-permission.field-middleware';

registerEnumType(StockTakeStatus, {
  name: 'StockTakeStatus',
  description: 'Where a stock-take is (P4-B.1)',
  valuesMap: {
    OPEN: { description: 'Counting: counts can be recorded' },
    SUBMITTED: { description: 'Counts closed, waiting for an approver' },
    APPROVED: { description: 'Variances posted to stock as STOCK_TAKE adjustments' },
    CANCELLED: { description: 'Stopped before approval; no stock moved' },
  },
});

const APPROVERS_ONLY = { middleware: [staffWith('inventory.stocktake.approve')] };

@ObjectType({ description: 'A stock count session at one location' })
export class StockTake {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  locationId: string;

  @Field(() => StockTakeStatus)
  status: StockTakeStatus;

  @Field(() => ID, { nullable: true, description: 'The category counted; null for a list of variants or a full count' })
  categoryId: string | null;

  @Field(() => String, { nullable: true })
  note: string | null;

  @Field(() => ID)
  openedById: string;

  @Field()
  openedAt: Date;

  @Field(() => ID, { nullable: true })
  submittedById: string | null;

  @Field(() => Date, { nullable: true })
  submittedAt: Date | null;

  @Field(() => ID, { nullable: true })
  approvedById: string | null;

  @Field(() => Date, { nullable: true })
  approvedAt: Date | null;

  @Field(() => ID, { nullable: true })
  cancelledById: string | null;

  @Field(() => Date, { nullable: true })
  cancelledAt: Date | null;

  @Field(() => String, { nullable: true })
  cancelReason: string | null;
}

@ObjectType({ description: 'One variant to count in a stock-take' })
export class StockTakeLine {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  stockTakeId: string;

  @Field(() => ID)
  variantId: string;

  @Field()
  sku: string;

  @Field()
  productName: string;

  @Field(() => Int, { nullable: true, description: 'Units counted; null until counted' })
  countedQuantity: number | null;

  @Field(() => ID, { nullable: true })
  countedById: string | null;

  @Field(() => Date, { nullable: true })
  countedAt: Date | null;

  @Field(() => Int, {
    description: 'Units expected on the shelf when the session opened (inventory.stocktake.approve only)',
    ...APPROVERS_ONLY,
  })
  expectedAtOpen: number;

  @Field(() => Int, {
    nullable: true,
    description: 'Units expected on the shelf when the line was counted (inventory.stocktake.approve only)',
    ...APPROVERS_ONLY,
  })
  expectedQuantity: number | null;

  @Field(() => Int, {
    nullable: true,
    description: 'countedQuantity - expectedQuantity (inventory.stocktake.approve only)',
    ...APPROVERS_ONLY,
  })
  variance: number | null;

  @Field(() => ID, { nullable: true, description: 'The STOCK_TAKE adjustment posted on approval' })
  movementId: string | null;
}

@ObjectType()
export class StockTakePage {
  @Field(() => [StockTake])
  nodes: StockTake[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node id as `after` to read the next page' })
  hasNextPage: boolean;
}

@ObjectType()
export class StockTakeLinePage {
  @Field(() => [StockTakeLine])
  nodes: StockTakeLine[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node id as `after` to read the next page' })
  hasNextPage: boolean;
}

@ObjectType({ description: 'A counted line of a stock-take with its variance' })
export class StockTakeVarianceLine {
  @Field(() => ID)
  variantId: string;

  @Field()
  sku: string;

  @Field()
  productName: string;

  @Field(() => Int, { description: 'Units expected on the shelf when the session opened' })
  expectedAtOpen: number;

  @Field(() => Int, { description: 'How the expected quantity moved between opening and the count (sales, receipts)' })
  changeSinceOpen: number;

  @Field(() => Int, { description: 'Units expected on the shelf when the line was counted' })
  expectedQuantity: number;

  @Field(() => Int)
  countedQuantity: number;

  @Field(() => Int, { description: 'countedQuantity - expectedQuantity: negative is a shortage' })
  variance: number;

  @Field(() => MoneyObject, { nullable: true, description: 'The variant’s current price; null when it has none' })
  unitPrice: Decimal | null;

  @Field(() => MoneyObject, { nullable: true, description: 'variance × unitPrice' })
  varianceValue: Decimal | null;
}

@ObjectType()
export class StockTakeVarianceTotals {
  @Field(() => Int)
  lineCount: number;

  @Field(() => Int)
  countedCount: number;

  @Field(() => Int, { description: 'Lines not counted: approval leaves their stock as it is' })
  uncountedCount: number;

  @Field(() => Int)
  linesWithVariance: number;

  @Field(() => Int, { description: 'Units missing, summed over shortages' })
  shortageUnits: number;

  @Field(() => Int, { description: 'Units found over what was expected' })
  surplusUnits: number;

  @Field(() => Int, { description: 'surplusUnits - shortageUnits' })
  netVarianceUnits: number;

  @Field(() => MoneyObject)
  shortageValue: Decimal;

  @Field(() => MoneyObject)
  surplusValue: Decimal;

  @Field(() => MoneyObject)
  netVarianceValue: Decimal;
}

@ObjectType({ description: 'Variances of a stock-take, valued at current prices (cost is not tracked yet)' })
export class StockTakeVarianceReport {
  @Field(() => StockTake)
  stockTake: StockTake;

  @Field(() => [StockTakeVarianceLine])
  lines: StockTakeVarianceLine[];

  @Field(() => StockTakeVarianceTotals)
  totals: StockTakeVarianceTotals;
}
