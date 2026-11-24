import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class RatingBucket {
  @Field(() => Int, { description: '1-5' })
  stars: number;

  @Field(() => Int)
  count: number;
}

@ObjectType({ description: 'Rating over the published reviews' })
export class ProductRating {
  @Field(() => Float, { nullable: true, description: 'Mean score to 2 decimals; null without reviews' })
  average: number | null;

  @Field(() => Int)
  count: number;

  @Field(() => [RatingBucket], { description: 'Reviews per star, 5 stars first' })
  distribution: RatingBucket[];
}
