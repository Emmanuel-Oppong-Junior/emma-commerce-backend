import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { PriceRange } from './price-range.entity';

@ObjectType({ description: 'A brand or category with the number of matching products' })
export class FacetCount {
  @Field(() => ID)
  id: string;

  @Field(() => String)
  name: string;

  @Field(() => Int)
  count: number;
}

@ObjectType()
export class AttributeFacetValue {
  @Field(() => String, { description: 'The value as stored (send it back in AttributeFilterInput.values)' })
  value: string;

  @Field(() => Int)
  count: number;
}

@ObjectType({ description: 'A filterable attribute and its most common values' })
export class AttributeFacet {
  @Field(() => String)
  key: string;

  @Field(() => String)
  label: string;

  @Field(() => [AttributeFacetValue], { description: 'Up to 20 values, most products first' })
  values: AttributeFacetValue[];
}

@ObjectType({
  description:
    'Facet counts for a product search (P6-S.2). Each facet ignores its own filter, so the other choices stay visible',
})
export class ProductFacets {
  @Field(() => Int, { description: 'Products matching every filter (the products totalCount)' })
  totalCount: number;

  @Field(() => Int, { description: 'Products that would match with inStock: true' })
  inStockCount: number;

  @Field(() => PriceRange, {
    nullable: true,
    description: 'Lowest and highest active variant price, without the price bounds; null when none is priced',
  })
  price: PriceRange | null;

  @Field(() => [FacetCount], { description: 'Up to 20 brands, most products first' })
  brands: FacetCount[];

  @Field(() => [FacetCount], { description: 'Up to 20 categories, most products first' })
  categories: FacetCount[];

  @Field(() => [AttributeFacet], {
    description: 'Up to 10 filterable attributes (AttributeDefinition.isFilterable) of the matching products',
  })
  attributes: AttributeFacet[];
}
