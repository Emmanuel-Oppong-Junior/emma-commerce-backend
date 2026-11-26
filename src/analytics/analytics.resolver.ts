import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AnalyticsService } from './analytics.service';
import { DashboardSummary } from './entities/dashboard-summary.entity';
import {
  AnalyticsRebuild,
  Cohort,
  ConversionReport,
  InventoryValuation,
  MarginReport,
  PromotionPerformance,
  SalesReport,
  TopCategory,
  TopProduct,
} from './entities/reports.entities';
import {
  BucketedReportArgs,
  CohortReportArgs,
  RankedReportArgs,
  RebuildAnalyticsInput,
  TopProductsArgs,
} from './dto/report.args';
import { RequirePermission } from '../iam/authorization/policy.decorators';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';

const RANGE_ERRORS = 'BAD_REQUEST for a day that does not exist, a last day before the first or more than 731 days';

@RequirePermission('report.view')
@Resolver()
export class AnalyticsResolver {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Query(() => SalesReport, {
    description: `Sales recognised per day, week or month: paid orders, revenue, discounts, refunds, AOV. ${RANGE_ERRORS}`,
  })
  salesReport(@Args() { firstDay, lastDay, bucket }: BucketedReportArgs) {
    return this.analyticsService.salesReport(firstDay, lastDay, bucket);
  }

  @Query(() => [TopProduct], { description: `Best-selling products of paid orders in a period. ${RANGE_ERRORS}` })
  topProducts(@Args() { firstDay, lastDay, first, orderBy }: TopProductsArgs) {
    return this.analyticsService.topProducts(firstDay, lastDay, first, orderBy);
  }

  @Query(() => [TopCategory], { description: `Categories by sales of paid orders in a period. ${RANGE_ERRORS}` })
  topCategories(@Args() { firstDay, lastDay, first }: RankedReportArgs) {
    return this.analyticsService.topCategories(firstDay, lastDay, first);
  }

  @RequirePermission('report.view', 'inventory.cost.view')
  @Query(() => MarginReport, {
    description: `Gross margin overall, by product and by category (first: rows per list). ${RANGE_ERRORS}`,
  })
  marginReport(@Args() { firstDay, lastDay, first }: RankedReportArgs) {
    return this.analyticsService.marginReport(firstDay, lastDay, first);
  }

  @Query(() => ConversionReport, { description: `The checkout funnel per day, week or month. ${RANGE_ERRORS}` })
  conversionReport(@Args() { firstDay, lastDay, bucket }: BucketedReportArgs) {
    return this.analyticsService.conversionReport(firstDay, lastDay, bucket);
  }

  @Query(() => [Cohort], {
    description:
      'Customer cohorts by the month of their first paid order: size, repeat rate and activity in the months after. ' +
      'BAD_REQUEST for more than 24 cohorts or a last month before the first',
  })
  cohortReport(@Args() { firstMonth, lastMonth, followMonths }: CohortReportArgs) {
    return this.analyticsService.cohortReport(firstMonth, lastMonth, followMonths);
  }

  @RequirePermission('report.view', 'inventory.cost.view')
  @Query(() => InventoryValuation, { description: 'Stock on hand valued at weighted-average cost, per location' })
  inventoryValuation() {
    return this.analyticsService.inventoryValuation();
  }

  @Query(() => [PromotionPerformance], {
    description: `Promotions and coupon codes by discount given on paid orders in a period. ${RANGE_ERRORS}`,
  })
  promotionPerformance(@Args() { firstDay, lastDay, first }: RankedReportArgs) {
    return this.analyticsService.promotionPerformance(firstDay, lastDay, first);
  }

  @Query(() => DashboardSummary, { description: "Today's sales (from the rollups) and live low-stock counts" })
  dashboardSummary() {
    return this.analyticsService.dashboardSummary();
  }

  @RequirePermission('report.view', 'jobs.manage')
  @Mutation(() => AnalyticsRebuild, {
    description:
      'Rebuilds the report rollups of a range of days in the background (after a data correction, or for history ' +
      `before analytics existed). ${RANGE_ERRORS}`,
  })
  rebuildAnalytics(@Args('input') input: RebuildAnalyticsInput, @ActiveUser('id') actorId: string) {
    return this.analyticsService.requestRebuild(input.firstDay, input.lastDay, actorId);
  }
}
