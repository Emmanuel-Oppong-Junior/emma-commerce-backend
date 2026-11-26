import { ArgsType, Field, InputType, Int, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsInt, Matches, Max, Min } from 'class-validator';
import { ReportBucket } from '../domain/report-range';
import { MAX_COHORT_MONTHS } from '../domain/cohorts';

export enum TopProductsOrder {
  UNITS = 'UNITS',
  SALES = 'SALES',
}

registerEnumType(ReportBucket, {
  name: 'ReportBucket',
  description: 'How a report groups its days (UTC = Ghana time)',
  valuesMap: {
    DAY: { description: 'One bucket per day' },
    WEEK: { description: 'ISO weeks, Monday to Sunday; the first and last are cut to the range' },
    MONTH: { description: 'Calendar months; the first and last are cut to the range' },
  },
});

registerEnumType(TopProductsOrder, {
  name: 'TopProductsOrder',
  valuesMap: {
    UNITS: { description: 'Most units sold first' },
    SALES: { description: 'Highest sales first' },
  },
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

@ArgsType()
export class ReportRangeArgs {
  @Field({ description: 'First day included (YYYY-MM-DD, UTC = Ghana time)' })
  @Matches(DAY, { message: 'firstDay must be a day as YYYY-MM-DD' })
  firstDay: string;

  @Field({ description: 'Last day included (YYYY-MM-DD); at most 731 days after firstDay' })
  @Matches(DAY, { message: 'lastDay must be a day as YYYY-MM-DD' })
  lastDay: string;
}

@ArgsType()
export class BucketedReportArgs extends ReportRangeArgs {
  @Field(() => ReportBucket, { defaultValue: ReportBucket.DAY })
  @IsEnum(ReportBucket)
  bucket: ReportBucket = ReportBucket.DAY;
}

@ArgsType()
export class RankedReportArgs extends ReportRangeArgs {
  @Field(() => Int, { defaultValue: 10, description: 'At most this many rows (1-100)' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 10;
}

@ArgsType()
export class TopProductsArgs extends RankedReportArgs {
  @Field(() => TopProductsOrder, { defaultValue: TopProductsOrder.UNITS })
  @IsEnum(TopProductsOrder)
  orderBy: TopProductsOrder = TopProductsOrder.UNITS;
}

@ArgsType()
export class CohortReportArgs {
  @Field({ description: 'First cohort: the month of a first paid order (YYYY-MM)' })
  @Matches(MONTH, { message: 'firstMonth must be a month as YYYY-MM' })
  firstMonth: string;

  @Field({ description: 'Last cohort (YYYY-MM); at most 24 cohorts' })
  @Matches(MONTH, { message: 'lastMonth must be a month as YYYY-MM' })
  lastMonth: string;

  @Field(() => Int, {
    defaultValue: 12,
    description: `Months followed after the first (0-${MAX_COHORT_MONTHS}), never past the current month`,
  })
  @IsInt()
  @Min(0)
  @Max(MAX_COHORT_MONTHS)
  followMonths: number = 12;
}

@InputType()
export class RebuildAnalyticsInput {
  @Field({ description: 'First day to rebuild (YYYY-MM-DD)' })
  @Matches(DAY, { message: 'firstDay must be a day as YYYY-MM-DD' })
  firstDay: string;

  @Field({ description: 'Last day to rebuild (YYYY-MM-DD); at most 731 days' })
  @Matches(DAY, { message: 'lastDay must be a day as YYYY-MM-DD' })
  lastDay: string;
}
