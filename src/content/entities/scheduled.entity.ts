import { Field, GraphQLISODateTime, ObjectType } from '@nestjs/graphql';

@ObjectType({ isAbstract: true })
export abstract class ScheduledContent {
  @Field(() => Boolean)
  isActive: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  startsAt: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Exclusive' })
  endsAt: Date | null;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}
