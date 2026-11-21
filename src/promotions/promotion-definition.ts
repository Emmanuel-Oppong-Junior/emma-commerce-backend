import { Decimal } from '@prisma/client/runtime/client';
import { PromotionScope, PromotionType } from '../generated/prisma/client';

/** The parts of a promotion that must agree with each other, as they will be stored. */
export interface PromotionDefinition {
  scope: PromotionScope;
  type: PromotionType;
  value: Decimal;
  targetIds: readonly string[];
  startsAt: Date;
  endsAt: Date | null;
}

/** Why the promotion, as it would be stored after a create or an update, is inconsistent; null when it is fine. */
export function promotionDefinitionError(definition: PromotionDefinition): string | null {
  const { scope, type, value, targetIds, startsAt, endsAt } = definition;
  if (type === PromotionType.PERCENT && value.gt(100)) {
    return `A PERCENT promotion's value must be at most 100, got ${value.toString()}`;
  }
  if (scope === PromotionScope.CART && type === PromotionType.FIXED_PRICE) {
    return 'A CART promotion cannot be FIXED_PRICE: a cart has no unit price to fix';
  }
  if (scope === PromotionScope.CART && targetIds.length > 0) return 'A CART promotion takes no targetIds';
  if (endsAt !== null && endsAt <= startsAt) return 'endsAt must be after startsAt';
  return null;
}
