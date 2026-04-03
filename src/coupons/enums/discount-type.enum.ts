import { registerEnumType } from '@nestjs/graphql';

export enum DiscountTypeEnum {
  PERCENTAGE = 'PERCENTAGE',
  FLAT = 'FLAT',
}

registerEnumType(DiscountTypeEnum, { name: 'DiscountTypeEnum' });
