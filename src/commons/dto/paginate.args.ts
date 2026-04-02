import { Field, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

@InputType()
export class PaginationArgs {
  @Field(() => Int, { defaultValue: 12 })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 12;

  @Field(() => String, { nullable: true, description: 'the id of the cursor' })
  @IsOptional()
  after?: string;

  @Field(() => String, { nullable: true, description: 'field to order by' })
  @IsOptional()
  orderBy?: string;

  @Field(() => Boolean, {
    nullable: true,
    description: 'boolean to determine order preference',
    defaultValue: true,
  })
  @IsOptional()
  orderInAsc?: boolean;
}
