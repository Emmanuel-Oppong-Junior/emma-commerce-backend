import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { AnalyticsService } from './analytics.service';
import { AnalyticsResolver } from './analytics.resolver';
import { AnalyticsCountersModule } from './counters/analytics-counters.module';
import { AnalyticsRollupRepository } from './rollup/analytics-rollup.repository';
import { AnalyticsRollupService } from './rollup/analytics-rollup.service';

@Module({
  imports: [CommonsModule, AnalyticsCountersModule],
  providers: [AnalyticsService, AnalyticsResolver, AnalyticsRollupService, AnalyticsRollupRepository],
  exports: [AnalyticsRollupService],
})
export class AnalyticsModule {}
