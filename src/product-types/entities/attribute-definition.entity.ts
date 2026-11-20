import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { AttributeDataTypeEnum } from '../enums/attribute-data-type.enum';

@ObjectType({ description: 'An attribute a product type defines for its products (or, for a variant axis, variants)' })
export class AttributeDefinition {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  productTypeId: string;

  @Field({ description: 'Key used in Product.attributes and Variant.optionValues, e.g. "size"' })
  key: string;

  @Field({ description: 'Label to show, e.g. "Size"' })
  label: string;

  @Field(() => AttributeDataTypeEnum)
  dataType: AttributeDataTypeEnum;

  @Field(() => String, { nullable: true, description: 'Unit of a NUMBER attribute, e.g. "g"' })
  unit: string | null;

  @Field()
  isRequired: boolean;

  @Field(() => [String], { description: 'The values allowed; empty means any value of the data type' })
  allowedValues: string[];

  @Field({ description: 'Set per variant (Variant.optionValues) rather than per product (Product.attributes)' })
  isVariantAxis: boolean;

  @Field({ description: 'Offered as a catalogue filter' })
  isFilterable: boolean;

  @Field(() => Int)
  position: number;
}
