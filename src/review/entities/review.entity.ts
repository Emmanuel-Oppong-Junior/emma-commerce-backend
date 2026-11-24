import { Field, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { ContentReportReason, ModerationStatus } from '../../generated/prisma/client';
import { PublicProfile } from '../../users/entities/public-profile.entity';
import { Product } from '../../products/entities/product.entity';
import { staffWith } from '../../iam/authorization/staff-permission.field-middleware';

registerEnumType(ContentReportReason, { name: 'ContentReportReason' });
registerEnumType(ModerationStatus, {
  name: 'ModerationStatus',
  description: 'PUBLISHED content is public; HIDDEN content was hidden by staff and only its author and staff see it',
});

@ObjectType()
export class ReviewPhoto {
  @Field(() => ID)
  id: string;

  @Field()
  url: string;
}

@ObjectType({ description: "The store's public reply to a review" })
export class ReviewReply {
  @Field()
  body: string;

  @Field(() => GraphQLISODateTime)
  repliedAt: Date;
}

@ObjectType()
export class Review {
  @Field(() => ID)
  id: string;

  @Field(() => Int)
  score: number;

  @Field(() => String, { nullable: true })
  title?: string | null;

  @Field(() => String, { nullable: true })
  comment?: string | null;

  @Field(() => ID)
  productId: string;

  /** Not a GraphQL field: reviews never expose who wrote them beyond the public profile. */
  userId: string;

  @Field({ description: 'Written by a customer who received the product; false on reviews older than the check' })
  verifiedPurchase: boolean;

  @Field(() => ModerationStatus)
  status: ModerationStatus;

  @Field(() => String, {
    nullable: true,
    description: 'Why staff hid it (staff with review.moderate only)',
    middleware: [staffWith('review.moderate')],
  })
  hiddenReason?: string | null;

  reply?: string | null;
  repliedAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'When its author last changed it' })
  editedAt?: Date | null;

  @Field(() => PublicProfile, { description: 'Public profile of the reviewer (never the full user)' })
  user: PublicProfile;

  @Field(() => Product)
  product: Product;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}

@ObjectType({ description: 'A customer report, without the reporter' })
export class ContentReport {
  @Field(() => ID)
  id: string;

  @Field(() => ContentReportReason)
  reason: ContentReportReason;

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;
}

@ObjectType({ description: 'A review with open reports, waiting for staff' })
export class ReportedReview {
  @Field(() => Review)
  review: Review;

  @Field(() => [ContentReport])
  openReports: ContentReport[];
}
