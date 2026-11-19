import { Cart, CartItem, Prisma } from '../../generated/prisma/client';
import { CreateDiscountInput } from '../dto/create-discount.input';
import { UpdateDiscountInput } from '../dto/update-discount.input';

export interface DiscountConnectInput {
  products?: { connect?: { id: string }[] };
  variants?: { connect?: { id: string }[] };
  categories?: { connect?: { id: string }[] };
}

export interface DiscountCalculation {
  discountedPrice: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  discountId?: string;
}

export interface DiscountSetInput {
  products?: { set?: { id: string }[] };
  variants?: { set?: { id: string }[] };
  categories?: { set?: { id: string }[] };
}

export interface CartWithDiscount extends Cart {
  items: CartItem[];
  total: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  finalTotal: Prisma.Decimal;
}

export type CreateOrUpdateDiscountInput = CreateDiscountInput | UpdateDiscountInput;
export type DiscountConnectOrSetInput = DiscountConnectInput | DiscountSetInput;
export type DiscountConnectionOperation = 'connect' | 'set';
