import { Field, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';
import { ModerationStatus } from '../generated/prisma/client';
import { PublicProfile } from '../users/entities/public-profile.entity';
import { Product } from '../products/entities/product.entity';
import { ContentReport } from '../review/entities/review.entity';
import { staffWith } from '../iam/authorization/staff-permission.field-middleware';

@ObjectType({ description: "A customer's question on a product and the store's answer" })
export class ProductQuestion {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  productId: string;

  /** Not a GraphQL field: the asker is shown only through the public profile. */
  userId: string;

  @Field()
  body: string;

  @Field(() => String, { nullable: true, description: "The store's answer; null until answered" })
  answer?: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  answeredAt?: Date | null;

  @Field(() => ModerationStatus)
  status: ModerationStatus;

  @Field(() => String, {
    nullable: true,
    description: 'Why staff hid it (staff with review.moderate only)',
    middleware: [staffWith('review.moderate')],
  })
  hiddenReason?: string | null;

  @Field(() => PublicProfile, { description: 'Public profile of the asker (never the full user)' })
  user: PublicProfile;

  @Field(() => Product)
  product: Product;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;
}

@ObjectType({ description: 'A product question with open reports, waiting for staff' })
export class ReportedProductQuestion {
  @Field(() => ProductQuestion)
  question: ProductQuestion;

  @Field(() => [ContentReport])
  openReports: ContentReport[];
}
