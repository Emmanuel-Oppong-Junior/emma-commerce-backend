import { ArgsType, Field, Int } from '@nestjs/graphql';
import { IsInt, Max, Min } from 'class-validator';

@ArgsType()
export class TopProductsArgs {
  @Field(() => Int, { defaultValue: 10 })
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 10;
}
