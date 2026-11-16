import { Field, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';
import { PublicProfile } from '../../users/entities/public-profile.entity';
import { Product } from '../../products/entities/product.entity';

@ObjectType()
export class Review {
  @Field(() => ID)
  id: string;

  @Field(() => Int)
  score: number;

  @Field(() => String, { nullable: true })
  comment?: string;

  @Field(() => ID)
  productId: string;

  @Field(() => ID)
  userId: string;

  @Field(() => PublicProfile, { description: 'Public profile of the reviewer (never the full user)' })
  user: PublicProfile;

  @Field(() => Product)
  product: Product;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}
