import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { MoneyObject } from '../../commons/money/money.object';
import { GraphQLDecimal } from '../../commons/money/decimal.scalar';

const REFRESH_NOTE =
  'Reports read daily rollups rebuilt every 15 minutes (today and the 7 days before) and by rebuildAnalytics';

@ObjectType({
  description:
    'Sales recognised in a period (P8-A). An order counts on the day it was paid (first accepted payment: online ' +
    'payment captured or cash collected), whenever it was placed; a refund counts on the day it was processed. ' +
    'grossRevenue = itemSales + shipping - order discounts not shared over the lines (only orders placed before ' +
    'P1-O.1); netRevenue = grossRevenue - refunds.',
})
export class SalesFigures {
  @Field(() => Int, { description: 'Orders paid' })
  paidOrders: number;

  @Field(() => Int, { description: 'Units on the paid orders' })
  unitsSold: number;

  @Field(() => MoneyObject, { description: 'Σ grandTotal of the paid orders (what was charged)' })
  grossRevenue: Decimal;

  @Field(() => MoneyObject, {
    description:
      'Σ what their lines were charged: after product discounts and their share of cart discounts, tax included',
  })
  itemSales: Decimal;

  @Field(() => MoneyObject, { description: 'Product discounts on the paid orders' })
  itemDiscounts: Decimal;

  @Field(() => MoneyObject, { description: 'Cart promotions and coupons on the paid orders' })
  orderDiscounts: Decimal;

  @Field(() => MoneyObject, { description: 'Loyalty points redeemed on the paid orders' })
  loyaltyDiscounts: Decimal;

  @Field(() => MoneyObject, { description: 'Delivery fees charged (after free-shipping promotions)' })
  shipping: Decimal;

  @Field(() => MoneyObject, { description: 'Free-shipping promotions taken off delivery fees' })
  shippingDiscounts: Decimal;

  @Field(() => MoneyObject, { description: 'Tax included in the paid orders' })
  tax: Decimal;

  @Field(() => Int, { description: 'Refunds processed' })
  refundCount: number;

  @Field(() => MoneyObject, { description: 'Refunds processed (FAILED and pending refunds excluded)' })
  refunds: Decimal;

  @Field(() => MoneyObject, { description: 'The delivery fees in those refunds' })
  refundedShipping: Decimal;

  @Field(() => MoneyObject, { description: 'The tax in those refunds' })
  refundedTax: Decimal;

  @Field(() => MoneyObject, { description: 'grossRevenue - refunds; negative when refunds exceed sales' })
  netRevenue: Decimal;

  @Field(() => MoneyObject, { description: 'netRevenue / paidOrders (0 without paid orders)' })
  averageOrderValue: Decimal;
}

@ObjectType()
export class SalesBucket extends SalesFigures {
  @Field({ description: 'First day of the bucket (YYYY-MM-DD)' })
  firstDay: string;

  @Field({ description: 'Last day of the bucket (YYYY-MM-DD)' })
  lastDay: string;
}

@ObjectType({ description: REFRESH_NOTE })
export class SalesReport {
  @Field(() => SalesFigures)
  totals: SalesFigures;

  @Field(() => [SalesBucket], { description: 'One per bucket, in order' })
  buckets: SalesBucket[];

  @Field(() => Date, { nullable: true, description: 'When the oldest day of the range was last computed' })
  refreshedAt: Date | null;

  @Field(() => Int, { description: 'Days of the range not computed yet (future days, or before a backfill)' })
  daysNotComputed: number;
}

@ObjectType({
  description:
    'Margin of the units sold (P8-A): tax-exclusive net sales (net of line refunds) minus the cost of goods sold at ' +
    "each line's cost snapshotted when its stock was consumed, less units put back in stock. Lines whose cost was " +
    'unknown are reported apart and left out of the margin.',
})
export class MarginFigures {
  @Field(() => Int)
  unitsSold: number;

  @Field(() => MoneyObject, { description: 'Tax-exclusive net sales of every line (costed + unknown cost)' })
  netSales: Decimal;

  @Field(() => MoneyObject, { description: 'Tax-exclusive net sales of lines with a known cost' })
  costedNetSales: Decimal;

  @Field(() => MoneyObject, { description: 'Cost of goods sold of those lines' })
  cogs: Decimal;

  @Field(() => MoneyObject, { description: 'costedNetSales - cogs' })
  grossMargin: Decimal;

  @Field(() => GraphQLDecimal, {
    nullable: true,
    description: 'grossMargin / costedNetSales, 4 dp (0.2500 = 25 %); null without costed sales',
  })
  marginRate: Decimal | null;

  @Field(() => Int, { description: 'Units sold whose cost was unknown' })
  unknownCostUnits: number;

  @Field(() => MoneyObject, { description: 'Their tax-exclusive net sales, left out of the margin' })
  unknownCostNetSales: Decimal;
}

@ObjectType()
export class ProductMargin extends MarginFigures {
  @Field(() => ID)
  productId: string;

  @Field()
  productName: string;

  @Field({ description: 'The product is archived' })
  archived: boolean;
}

@ObjectType()
export class CategoryMargin extends MarginFigures {
  @Field(() => ID, { nullable: true, description: 'Null for products without a category' })
  categoryId: string | null;

  @Field(() => String, { nullable: true })
  categoryName: string | null;
}

@ObjectType({ description: `Margins over a period (report.view and inventory.cost.view). ${REFRESH_NOTE}` })
export class MarginReport {
  @Field(() => MarginFigures)
  overall: MarginFigures;

  @Field(() => [ProductMargin], { description: 'Highest gross margin first' })
  byProduct: ProductMargin[];

  @Field(() => [CategoryMargin], { description: 'Highest gross margin first (by current product category)' })
  byCategory: CategoryMargin[];

  @Field(() => MoneyObject, {
    description: 'Goods refunded without order lines (e.g. older return refunds): in netRevenue, not in margins',
  })
  unallocatedRefunds: Decimal;
}

@ObjectType({ description: 'A product ranked by what it sold in a period (paid orders)' })
export class TopProduct {
  @Field(() => ID)
  productId: string;

  @Field()
  productName: string;

  @Field({ description: 'The product is archived' })
  archived: boolean;

  @Field(() => Int)
  unitsSold: number;

  @Field(() => Int, { description: 'Units refunded in the period' })
  unitsRefunded: number;

  @Field(() => MoneyObject, { description: 'What the units sold were charged, tax included (itemSales share)' })
  sales: Decimal;

  @Field(() => MoneyObject, { description: 'Line refunds processed in the period' })
  refunds: Decimal;

  @Field(() => MoneyObject, { description: 'sales - refunds' })
  netSales: Decimal;
}

@ObjectType({ description: 'A category ranked by what its products sold in a period (current categorisation)' })
export class TopCategory {
  @Field(() => ID, { nullable: true, description: 'Null for products without a category' })
  categoryId: string | null;

  @Field(() => String, { nullable: true })
  categoryName: string | null;

  @Field(() => Int)
  unitsSold: number;

  @Field(() => MoneyObject, { description: 'What the units sold were charged, tax included' })
  sales: Decimal;

  @Field(() => MoneyObject)
  refunds: Decimal;

  @Field(() => MoneyObject, { description: 'sales - refunds' })
  netSales: Decimal;
}

@ObjectType({
  description:
    'The checkout funnel (no tracking pixel): carts started (first item added to an empty cart), checkout quotes ' +
    'given, orders placed, orders paid. Each step counts on its own day, so a short period can show ratios above 1.',
})
export class FunnelFigures {
  @Field(() => Int)
  cartsStarted: number;

  @Field(() => Int)
  checkoutQuotes: number;

  @Field(() => Int)
  ordersPlaced: number;

  @Field(() => Int)
  paidOrders: number;

  @Field(() => Float, { nullable: true, description: 'checkoutQuotes / cartsStarted, 4 dp' })
  quoteRate: number | null;

  @Field(() => Float, { nullable: true, description: 'ordersPlaced / checkoutQuotes, 4 dp' })
  placementRate: number | null;

  @Field(() => Float, { nullable: true, description: 'paidOrders / ordersPlaced, 4 dp' })
  paymentRate: number | null;

  @Field(() => Float, { nullable: true, description: 'paidOrders / cartsStarted, 4 dp' })
  conversionRate: number | null;
}

@ObjectType()
export class FunnelBucket extends FunnelFigures {
  @Field()
  firstDay: string;

  @Field()
  lastDay: string;
}

@ObjectType({ description: REFRESH_NOTE })
export class ConversionReport {
  @Field(() => FunnelFigures)
  totals: FunnelFigures;

  @Field(() => [FunnelBucket])
  buckets: FunnelBucket[];

  @Field(() => Date, { nullable: true })
  refreshedAt: Date | null;

  @Field(() => Int)
  daysNotComputed: number;
}

@ObjectType()
export class CohortMonth {
  @Field(() => Int, { description: 'Months after the cohort month (0 = that month)' })
  offset: number;

  @Field(() => Int, { description: 'Customers of the cohort who paid for an order that month' })
  activeCustomers: number;

  @Field(() => Int)
  orders: number;

  @Field(() => MoneyObject, { description: 'Their paid order totals minus refunds processed that month' })
  netRevenue: Decimal;
}

@ObjectType({
  description:
    'Customers whose first paid order fell in the month. A customer is an account, or a guest phone for guest orders ' +
    'not attached to an account.',
})
export class Cohort {
  @Field({ description: 'YYYY-MM' })
  month: string;

  @Field(() => Int)
  customers: number;

  @Field(() => Int, { description: 'Customers who paid for at least one more order since' })
  repeatCustomers: number;

  @Field(() => Float, { nullable: true, description: 'repeatCustomers / customers, 4 dp' })
  repeatRate: number | null;

  @Field(() => [CohortMonth])
  months: CohortMonth[];
}

@ObjectType()
export class LocationValuation {
  @Field(() => ID)
  locationId: string;

  @Field()
  locationName: string;

  @Field()
  isActive: boolean;

  @Field(() => Int, { description: 'Units on hand' })
  units: number;

  @Field(() => MoneyObject, { description: 'Units of known cost x the variant cost price' })
  value: Decimal;

  @Field(() => Int, { description: 'Units on hand of variants with no cost price, left out of value' })
  unknownCostUnits: number;
}

@ObjectType({
  description:
    'Stock on hand at weighted-average cost now (report.view and inventory.cost.view), computed live. Variants ' +
    'without a cost price are counted apart, never valued at zero.',
})
export class InventoryValuation {
  @Field(() => Int)
  units: number;

  @Field(() => MoneyObject)
  value: Decimal;

  @Field(() => Int)
  unknownCostUnits: number;

  @Field(() => Int, { description: 'Variants with stock on hand and no cost price' })
  unknownCostVariants: number;

  @Field(() => [LocationValuation])
  locations: LocationValuation[];
}

@ObjectType({ description: 'How a promotion (and coupon code) did on the orders paid in a period' })
export class PromotionPerformance {
  @Field(() => ID)
  promotionId: string;

  @Field(() => String, { nullable: true, description: 'Null once the promotion was deleted' })
  promotionName: string | null;

  @Field(() => String, { nullable: true, description: 'The coupon code that unlocked it; null when automatic' })
  couponCode: string | null;

  @Field(() => Int, { description: 'Paid orders it applied to (redemptions)' })
  orders: number;

  @Field(() => MoneyObject, { description: 'What it took off those orders (goods and delivery fee)' })
  discount: Decimal;

  @Field(() => MoneyObject, { description: 'Σ grandTotal of those orders' })
  revenue: Decimal;

  @Field(() => Int, { description: 'Units bought at its price (flash sales, BXGY, tiers)' })
  units: number;
}

@ObjectType()
export class AnalyticsRebuild {
  @Field(() => ID, { description: 'The maintenance job rebuilding the days' })
  jobId: string;

  @Field()
  firstDay: string;

  @Field()
  lastDay: string;
}
