import { Field, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';
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

  @Field(() => [AttributeDefinition], { description: 'Attribute definitions in display order' })
  attributes: AttributeDefinition[];

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}
