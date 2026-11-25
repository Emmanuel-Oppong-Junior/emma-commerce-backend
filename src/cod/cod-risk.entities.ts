import { ArgsType, Field, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Decimal } from '@prisma/client/runtime/client';
import { CodBlacklistKind } from '../generated/prisma/client';
import { MoneyObject } from '../commons/money/money.object';
import { DecimalInputField, IsMoneyAmount } from '../commons/money/decimal.scalar';
import { CodUnavailableReason, MAX_OPEN_ORDERS_LIMIT } from './cod-risk';

registerEnumType(CodUnavailableReason, {
  name: 'CodUnavailableReason',
  description: 'Why cash on delivery is not available for a checkout (the customer can still pay online)',
});
registerEnumType(CodBlacklistKind, {
  name: 'CodBlacklistKind',
  description: 'What a cash-on-delivery blacklist entry matches: a phone number, a GhanaPost GPS code or a street',
});

@ObjectType({ description: 'Whether this checkout could be paid on delivery' })
export class CashOnDeliveryAvailability {
  @Field()
  available: boolean;

  @Field(() => CodUnavailableReason, { nullable: true, description: 'The first gate refusing it, when not available' })
  reason: CodUnavailableReason | null;

  @Field({
    description:
      "Whether the account's phone number is verified (required once for cash on delivery); for a guest checkout, " +
      "whether the guest's phone is verified (guests pay online only: reason GUEST_CHECKOUT)",
  })
  phoneVerified: boolean;
}

@ObjectType({ description: 'Cash-on-delivery risk limits of the store' })
export class CodRiskSettingsEntity {
  @Field(() => Int, {
    description: 'Open cash-on-delivery orders (placed, confirmed or in fulfilment) per verified phone',
  })
  maxOpenOrdersPerPhone: number;

  @Field(() => MoneyObject, { description: 'Highest grand total that may be paid on delivery' })
  maxOrderTotal: Decimal;
}

@InputType()
export class UpdateCodRiskSettingsInput {
  @Field(() => Int, { nullable: true, description: `Whole number from 1 to ${MAX_OPEN_ORDERS_LIMIT}` })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_OPEN_ORDERS_LIMIT)
  maxOpenOrdersPerPhone?: number;

  @DecimalInputField({ nullable: true, description: 'Above 0, at most 2 decimals, in the store currency' })
  @IsOptional()
  @IsMoneyAmount({ positive: true })
  maxOrderTotal?: Decimal;
}

@ObjectType({ description: 'A phone number or delivery address refused cash on delivery' })
export class CodBlacklistEntryEntity {
  @Field(() => ID)
  id: string;

  @Field(() => CodBlacklistKind)
  kind: CodBlacklistKind;

  @Field({ description: 'The normalised value matched: E.164 phone, GPS code without separators, or "street|city"' })
  value: string;

  @Field()
  reason: string;

  @Field(() => String, { nullable: true, description: 'The staff member who added it' })
  createdById: string | null;

  @Field()
  createdAt: Date;
}

@InputType({ description: 'Exactly one of phone, ghanaPostGps, or street with city, and why' })
export class AddCodBlacklistEntryInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @Field({ nullable: true, description: 'GhanaPost GPS code, e.g. GA-183-8164' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  ghanaPostGps?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  street?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

@ArgsType()
export class CodBlacklistArgs {
  @Field(() => Int, { defaultValue: 50, description: 'How many entries, newest first (1 to 200)' })
  @IsInt()
  @Min(1)
  @Max(200)
  first: number;
}
