import { ArgsType, Field } from '@nestjs/graphql';
import { IsDate } from 'class-validator';
import { Type } from 'class-transformer';

@ArgsType()
export class SalesReportArgs {
  @Field()
  @IsDate()
  @Type(() => Date)
  startDate: Date;

  @Field()
  @IsDate()
  @Type(() => Date)
  endDate: Date;
}
