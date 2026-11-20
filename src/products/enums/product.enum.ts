import { registerEnumType } from '@nestjs/graphql';

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

export enum FulfilmentKindEnum {
  PHYSICAL = 'PHYSICAL',
  DIGITAL = 'DIGITAL',
  SERVICE = 'SERVICE',
}

registerEnumType(FulfilmentKindEnum, {
  name: 'FulfilmentKind',
  description: 'How the product reaches the customer: shipped or collected, delivered digitally, or performed',
});

export enum UnitOfMeasureEnum {
  EACH = 'EACH',
  KG = 'KG',
  G = 'G',
  L = 'L',
  ML = 'ML',
  M = 'M',
}

registerEnumType(UnitOfMeasureEnum, { name: 'UnitOfMeasure', description: 'Unit the product is sold in' });
