import { Field, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';
import { AttributeDefinition } from './attribute-definition.entity';

@ObjectType({ description: 'A kind of product (e.g. Apparel) and the attributes its products and variants carry' })
export class ProductType {
  @Field(() => ID)
  id: string;

  @Field({ description: 'Stable identifier, e.g. "apparel"' })
  key: string;

  @Field()
  name: string;

  @Field(() => String, { nullable: true })
  description: string | null;

  @Field({ description: 'Seeded by the platform and read-only' })
  isSystem: boolean;

  @Field({ description: 'Whether its products can be returned (false: perishables, hygiene, digital goods)' })
  returnable: boolean;

  @Field(() => Int, {
    nullable: true,
    description: "Days after delivery its products may be returned in; null takes the store's returnWindowDays",
  })
  returnWindowDays: number | null;

  @Field(() => [AttributeDefinition], { description: 'Attribute definitions in display order' })
  attributes: AttributeDefinition[];

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}
