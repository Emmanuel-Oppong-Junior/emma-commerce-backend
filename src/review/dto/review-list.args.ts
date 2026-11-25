import { ArgsType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export enum ReviewSort {
  NEWEST = 'NEWEST',
  HIGHEST = 'HIGHEST',
  LOWEST = 'LOWEST',
}

registerEnumType(ReviewSort, {
  name: 'ReviewSort',
  description: 'NEWEST first, HIGHEST or LOWEST score first (newest first within a score)',
});

@ArgsType()
export class ContentPageArgs {
  @Field(() => Int, { defaultValue: 20, description: '1-50' })
  @IsInt()
  @Min(1)
  @Max(50)
  first: number = 20;

  @Field(() => ID, { nullable: true, description: 'The id of the last item of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}

@ArgsType()
export class ProductReviewsArgs extends ContentPageArgs {
  @Field(() => ID)
  @IsString()
  productId: string;

  @Field(() => ReviewSort, { defaultValue: ReviewSort.NEWEST })
  @IsEnum(ReviewSort)
  sort: ReviewSort = ReviewSort.NEWEST;
}
