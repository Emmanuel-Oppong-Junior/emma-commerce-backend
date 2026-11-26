import { Global, Module } from '@nestjs/common';
import { CommonsModule } from '../../commons/commons.module';
import { AnalyticsCounters } from './analytics-counters';
import { CountCartStarts, CountCheckoutQuotes } from './counting.interceptors';

// Global: the counting interceptors sit on cart and checkout resolvers of other modules, which resolve them here.
@Global()
@Module({
  imports: [CommonsModule],
  providers: [AnalyticsCounters, CountCartStarts, CountCheckoutQuotes],
  exports: [AnalyticsCounters, CountCartStarts, CountCheckoutQuotes],
})
export class AnalyticsCountersModule {}
