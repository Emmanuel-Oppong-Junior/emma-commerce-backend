import { Args, Query, Resolver } from '@nestjs/graphql';
import { AnalyticsService } from './analytics.service';
import { SalesReport } from './entities/sales-report.entity';
import { TopProduct } from './entities/top-product.entity';
import { RevenueByCategoryEntity } from './entities/revenue-by-category.entity';
import { DashboardSummary } from './entities/dashboard-summary.entity';
import { SalesReportArgs } from './dto/sales-report.args';
import { TopProductsArgs } from './dto/top-products.args';
import { RequirePermission } from '../iam/authorization/policy.decorators';

@RequirePermission('report.view')
@Resolver()
export class AnalyticsResolver {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Query(() => SalesReport, {
    description: 'Gross revenue, refunds and net revenue recognised in a date range (admin only)',
  })
  salesReport(@Args() args: SalesReportArgs) {
    return this.analyticsService.getSalesReport(args.startDate, args.endDate);
  }

  @Query(() => [TopProduct], { description: 'Best-selling products of paid orders by quantity, all time (admin only)' })
  topProducts(@Args() args: TopProductsArgs) {
    return this.analyticsService.getTopProducts(args.limit);
  }

  @Query(() => [RevenueByCategoryEntity], {
    description: 'Item sales of paid orders grouped by category, all time (admin only)',
  })
  revenueByCategory() {
    return this.analyticsService.getRevenueByCategory();
  }

  @Query(() => DashboardSummary, { description: 'Admin dashboard summary (admin only)' })
  dashboardSummary() {
    return this.analyticsService.getDashboardSummary();
  }
}
