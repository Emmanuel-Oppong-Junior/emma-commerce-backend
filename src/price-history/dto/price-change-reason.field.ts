import { applyDecorators } from '@nestjs/common';
import { Field } from '@nestjs/graphql';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export const MAX_PRICE_CHANGE_REASON_LENGTH = 500;

/** The optional `priceChangeReason` of an admin write that can change variant prices; stored on its PriceChange rows. */
export function PriceChangeReasonField(): PropertyDecorator {
  return applyDecorators(
    Field(() => String, {
      nullable: true,
      description: `Why prices change, kept in the price history (max ${MAX_PRICE_CHANGE_REASON_LENGTH} characters)`,
    }),
    IsOptional(),
    IsString(),
    MaxLength(MAX_PRICE_CHANGE_REASON_LENGTH),
  );
}
