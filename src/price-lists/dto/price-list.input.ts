import { ArgsType, Field, GraphQLISODateTime, ID, InputType, Int } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';

const MAX_GROUPS = 100;
const MAX_TIERS = 20;
const MAX_ENTRIES_PER_CALL = 200;

@InputType({ description: 'A new price list in the store currency; it starts inactive unless isActive is true' })
export class CreatePriceListInput {
  @Field({ description: 'Unique, max 100' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @Field({ defaultValue: false })
  @IsBoolean()
  isActive: boolean = false;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Null: open from creation' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  startsAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Null: open-ended' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  endsAt?: Date | null;

  @Field(() => Int, { defaultValue: 0, description: 'Lowest number wins a tie between equal prices, then the oldest' })
  @IsInt()
  priority: number = 0;

  @Field({
    defaultValue: false,
    description:
      'Promotions apply on top of its prices. When false, lines priced from it get no promotion and do not count ' +
      'towards any minimum spend or quantity, nor share a cart promotion',
  })
  @IsBoolean()
  allowPromotions: boolean = false;

  @Field(() => [ID], { defaultValue: [], description: 'Members of these customer groups get its prices' })
  @IsArray()
  @ArrayMaxSize(MAX_GROUPS)
  @IsString({ each: true })
  customerGroupIds: string[] = [];
}

@InputType({
  description:
    'Changes to a price list: omitted fields stay as they are, null clears an optional one; customerGroupIds, when ' +
    'given, replaces the groups',
})
export class UpdatePriceListInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  startsAt?: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  endsAt?: Date | null;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  priority?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  allowPromotions?: boolean;

  @Field(() => [ID], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_GROUPS)
  @IsString({ each: true })
  customerGroupIds?: string[];
}

@InputType({ description: 'A quantity break: from minQuantity units, each costs price' })
export class PriceListTierInput {
  @Field(() => Int, { description: "Above the entry's minQuantity and the previous tier's" })
  @IsInt()
  @Min(2)
  minQuantity: number;

  @DecimalInputField({ description: 'Tax included, like Variant.price; at most the price of the break below' })
  @IsMoneyAmount({ positive: true })
  price: Decimal;
}

@InputType({ description: "A variant's price in a list" })
export class PriceListEntryInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  variantId: string;

  @DecimalInputField({
    description:
      'Unit price from minQuantity units, tax included like Variant.price; never charged above the normal price',
  })
  @IsMoneyAmount({ positive: true })
  price: Decimal;

  @Field(() => Int, {
    defaultValue: 1,
    description: 'Minimum quantity (MOQ) for the list price; below it the normal price applies (nothing is refused)',
  })
  @IsInt()
  @Min(1)
  minQuantity: number = 1;

  @Field(() => [PriceListTierInput], { defaultValue: [], description: 'Lower prices for larger quantities, ascending' })
  @IsArray()
  @ArrayMaxSize(MAX_TIERS)
  @ValidateNested({ each: true })
  @Type(() => PriceListTierInput)
  tiers: PriceListTierInput[] = [];
}

@InputType()
export class SetPriceListEntriesInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  priceListId: string;

  @Field(() => [PriceListEntryInput], {
    description: `1-${MAX_ENTRIES_PER_CALL} entries; each replaces its variant's entry (with its tiers) in the list`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ENTRIES_PER_CALL)
  @ValidateNested({ each: true })
  @Type(() => PriceListEntryInput)
  entries: PriceListEntryInput[];
}

@InputType()
export class RemovePriceListEntriesInput {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  priceListId: string;

  @Field(() => [ID], { description: `1-${MAX_ENTRIES_PER_CALL} variant ids` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ENTRIES_PER_CALL)
  @IsString({ each: true })
  variantIds: string[];
}

@ArgsType()
export class PriceListsArgs {
  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** One page of a list's entries, by variant id; `after` is the last variant id of the previous page. */
@ArgsType()
export class PriceListEntriesArgs {
  @Field(() => Int, { defaultValue: 50, description: '1-200' })
  @IsInt()
  @Min(1)
  @Max(200)
  first: number = 50;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  after?: string;
}
