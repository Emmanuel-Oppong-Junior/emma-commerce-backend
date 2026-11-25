import { registerEnumType } from '@nestjs/graphql';

export enum ProductSortField {
  RELEVANCE = 'relevance',
  NAME = 'name',
  CREATED_AT = 'createdAt',
  UPDATED_AT = 'updatedAt',
}

registerEnumType(ProductSortField, {
  name: 'ProductSortField',
  description: 'Fields by which products can be sorted',
  valuesMap: {
    RELEVANCE: { description: 'Best search match first (ignores sortOrder); without search text, newest first' },
    NAME: { description: 'Sort by product name' },
    CREATED_AT: { description: 'Sort by creation date' },
    UPDATED_AT: { description: 'Sort by last update date' },
  },
});
