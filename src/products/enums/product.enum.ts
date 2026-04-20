import { registerEnumType } from '@nestjs/graphql';

export enum StockStatusEnum {
  IN_STOCK = 'IN_STOCK',
  OUT_OF_STOCK = 'OUT_OF_STOCK',
  PREORDER = 'PREORDER',
  BACKORDER = 'BACKORDER',
}

registerEnumType(StockStatusEnum, { name: 'StockStatus' });

export enum ProductStatusEnum {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  ARCHIVED = 'ARCHIVED',
}

registerEnumType(ProductStatusEnum, { name: 'ProductStatus' });

export enum CurrencyEnum {
  GHS = 'GHS',
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
  NGN = 'NGN',
}

registerEnumType(CurrencyEnum, { name: 'Currency' });

export enum DeliveryOptionsEnum {
  LOCAL_DELIVERY = 'LOCAL_DELIVERY',
  INTERNATIONAL_DELIVERY = 'INTERNATIONAL_DELIVERY',
  SELECTED_REGIONS = 'SELECTED_REGIONS',
}

registerEnumType(DeliveryOptionsEnum, { name: 'DeliveryOptions' });
