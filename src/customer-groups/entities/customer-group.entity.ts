import { Field, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'A customer in a group (staff view): the user id only' })
export class CustomerGroupMember {
  @Field(() => ID)
  userId: string;

  @Field(() => GraphQLISODateTime, { description: 'When the customer was added' })
  createdAt: Date;
}

@ObjectType({ description: 'A named set of customers; promotions may be limited to groups (staff view)' })
export class CustomerGroup {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field(() => String, { nullable: true })
  description: string | null;

  @Field(() => Int)
  memberCount: number;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}

@ObjectType()
export class CustomerGroupMemberPage {
  @Field(() => [CustomerGroupMember])
  nodes: CustomerGroupMember[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node userId as `after` to read the next page' })
  hasNextPage: boolean;
}
