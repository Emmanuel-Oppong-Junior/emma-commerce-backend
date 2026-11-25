import { Field, InputType } from '@nestjs/graphql';
import { ArrayMaxSize, ArrayMinSize, IsString, Matches, MaxLength } from 'class-validator';
import { ATTRIBUTE_KEY_PATTERN } from '../../product-types/dto/attribute-definition.input';

export const MAX_ATTRIBUTE_FILTERS = 10;
export const MAX_ATTRIBUTE_FILTER_VALUES = 20;

@InputType({ description: 'Products whose attribute is one of the values (P6-S.2)' })
export class AttributeFilterInput {
  @Field(() => String, { description: 'Attribute key, e.g. "colour" (a product attribute or a variant axis)' })
  @Matches(ATTRIBUTE_KEY_PATTERN, { message: 'key must be an attribute key: a-z, 0-9 and _, starting with a letter' })
  key: string;

  @Field(() => [String], {
    description: 'Values to match, ignoring case (any of them; 1-20), as productFacets lists them',
  })
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ATTRIBUTE_FILTER_VALUES)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  values: string[];
}
