import { registerEnumType } from '@nestjs/graphql';

export enum ProductSortField {
  PRICE = 'price',
  NAME = 'name',
  CREATED_AT = 'createdAt',
  UPDATED_AT = 'updatedAt',
  QUANTITY = 'quantity',
}

registerEnumType(ProductSortField, {
  name: 'ProductSortField',
  description: 'Fields by which products can be sorted',
  valuesMap: {
    PRICE: { description: 'Sort by price' },
    NAME: { description: 'Sort by product name' },
    CREATED_AT: { description: 'Sort by creation date' },
    UPDATED_AT: { description: 'Sort by last update date' },
    QUANTITY: { description: 'Sort by stock quantity' },
  },
});
