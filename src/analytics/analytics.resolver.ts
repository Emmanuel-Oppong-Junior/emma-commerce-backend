import { Args, Query, Resolver } from '@nestjs/graphql';
import { AnalyticsService } from './analytics.service';
import { SalesReport } from './entities/sales-report.entity';
import { TopProduct } from './entities/top-product.entity';
import { RevenueByCategoryEntity } from './entities/revenue-by-category.entity';
import { DashboardSummary } from './entities/dashboard-summary.entity';
import { SalesReportArgs } from './dto/sales-report.args';
import { TopProductsArgs } from './dto/top-products.args';
import { Roles } from '../iam/authentication/decorators/roles.decorator';
import { Role } from '../users/enums/role.enum';

@Roles(Role.ADMIN, Role.SUPER_ADMIN)
@Resolver()
export class AnalyticsResolver {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Query(() => SalesReport, { description: 'Sales report for a date range (admin only)' })
  salesReport(@Args() args: SalesReportArgs) {
    return this.analyticsService.getSalesReport(args.startDate, args.endDate);
  }

  @Query(() => [TopProduct], { description: 'Best-selling products by quantity (admin only)' })
  topProducts(@Args() args: TopProductsArgs) {
    return this.analyticsService.getTopProducts(args.limit);
  }

  @Query(() => [RevenueByCategoryEntity], { description: 'Revenue grouped by category (admin only)' })
  revenueByCategory() {
    return this.analyticsService.getRevenueByCategory();
  }

  @Query(() => DashboardSummary, { description: 'Admin dashboard summary (admin only)' })
  dashboardSummary() {
    return this.analyticsService.getDashboardSummary();
  }
}
