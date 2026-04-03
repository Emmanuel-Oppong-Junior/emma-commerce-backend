import { registerEnumType } from '@nestjs/graphql';

export enum InventoryActionEnum {
  RESTOCK = 'RESTOCK',
  ORDER_DEDUCTION = 'ORDER_DEDUCTION',
  RETURN_RESTORE = 'RETURN_RESTORE',
  ADJUSTMENT = 'ADJUSTMENT',
}

registerEnumType(InventoryActionEnum, { name: 'InventoryActionEnum' });
