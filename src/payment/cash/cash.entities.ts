import { ArgsType, Field, GraphQLISODateTime, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Decimal } from '@prisma/client/runtime/client';
import { MoneyObject } from '../../commons/money/money.object';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';
import { PageInfo } from '../../commons/entities/pageInfo.entity';
import { DiscrepancyKind } from './cash-remittance';

registerEnumType(DiscrepancyKind, {
  name: 'CashDiscrepancyKind',
  description: 'SHORT: the rider handed in less than the collections add up to; OVER: more',
});

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const MAX_COLLECTIONS_PER_REMITTANCE = 500;

@ObjectType({ description: 'Cash a rider collected for one cash-on-delivery order' })
export class CashCollectionEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  orderId: string;

  @Field(() => Int)
  orderNumber: number;

  @Field(() => ID, { nullable: true, description: 'The captured cash payment (attempt)' })
  attemptId: string | null;

  @Field(() => ID, { nullable: true, description: 'The staff member who took the cash; null before P3-B.3' })
  riderId: string | null;

  @Field(() => ID, { nullable: true, description: 'The staff member who recorded it' })
  recordedById: string | null;

  @Field(() => MoneyObject)
  amount: Decimal;

  @Field()
  currency: string;

  @Field(() => GraphQLISODateTime)
  collectedAt: Date;

  @Field(() => ID, { nullable: true, description: 'The remittance it was handed in with; null while outstanding' })
  remittanceId: string | null;
}

@ObjectType({ description: 'Cash a rider handed to the store; immutable (a correction is a new remittance)' })
export class CashRemittanceEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  riderId: string;

  @Field(() => ID, { description: 'The staff member who received the cash and recorded it' })
  receivedById: string;

  @Field(() => MoneyObject, { description: 'The cash handed in' })
  amount: Decimal;

  @Field(() => MoneyObject, { description: 'What the covered collections add up to' })
  expectedAmount: Decimal;

  @Field(() => String, {
    description:
      'amount - expectedAmount with 2 decimals, e.g. "-20.00" (short) or "5.00" (over); "0.00" when it matches',
  })
  discrepancy: string;

  @Field(() => DiscrepancyKind, { nullable: true, description: 'Null when the remittance matches its collections' })
  discrepancyKind: DiscrepancyKind | null;

  @Field()
  currency: string;

  @Field(() => String, { nullable: true })
  note: string | null;

  @Field(() => GraphQLISODateTime)
  receivedAt: Date;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => [CashCollectionEntity], { description: 'The collections it covers (none for an adjusting entry)' })
  collections: CashCollectionEntity[];
}

@InputType()
export class RecordCashRemittanceInput {
  @Field(() => ID, { description: 'The rider handing in the cash' })
  @IsString()
  @IsNotEmpty()
  riderId: string;

  @DecimalInputField({ description: 'The cash handed in (0 or more)' })
  @IsMoneyAmount()
  amount: Decimal;

  @Field(() => [ID], {
    description: `The rider's unremitted collections this cash covers (at most ${MAX_COLLECTIONS_PER_REMITTANCE}); empty for an adjusting entry`,
  })
  @IsArray()
  @ArrayMaxSize(MAX_COLLECTIONS_PER_REMITTANCE)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  collectionIds: string[];

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'When the cash was received (default now)' })
  @IsOptional()
  @IsDate()
  receivedAt?: Date;

  @Field(() => String, { nullable: true, description: 'Required when the amount differs from the collections' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;
}

@ArgsType()
export class CashRemittancesArgs {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  riderId?: string;

  @Field(() => Int, { defaultValue: 20, description: '1-100, newest first' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 20;
}

@InputType()
export class CodCashReportInput {
  @Field(() => GraphQLISODateTime, { description: 'Start of the range (inclusive)' })
  @IsDate()
  from: Date;

  @Field(() => GraphQLISODateTime, { description: 'End of the range (exclusive)' })
  @IsDate()
  to: Date;

  @Field(() => ID, { nullable: true, description: 'Only this rider' })
  @IsOptional()
  @IsString()
  riderId?: string;

  @Field(() => Int, { defaultValue: 20, description: 'Riders per page, 1-100' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 20;

  @Field(() => ID, { nullable: true, description: 'The last riderId of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}

@ObjectType({ description: "One rider's cash for the range" })
export class CodRiderCashSummary {
  @Field(() => ID)
  riderId: string;

  @Field(() => String, { nullable: true })
  riderName: string | null;

  @Field(() => Int, { description: 'Collections taken in the range' })
  collectionsCount: number;

  @Field(() => MoneyObject)
  collectedTotal: Decimal;

  @Field(() => Int, { description: 'Collections taken in the range and not remitted yet' })
  outstandingCount: number;

  @Field(() => MoneyObject)
  outstandingTotal: Decimal;

  @Field(() => Int, { description: 'Remittances received in the range' })
  remittancesCount: number;

  @Field(() => MoneyObject)
  remittedTotal: Decimal;

  @Field(() => Int, { description: 'Remittances received in the range that were short or over' })
  discrepancyCount: number;

  @Field(() => MoneyObject, { description: 'Sum of the shortfalls (a positive amount)' })
  shortTotal: Decimal;

  @Field(() => MoneyObject)
  overTotal: Decimal;

  @Field(() => String, { description: 'overTotal - shortTotal with 2 decimals; negative when the rider owes cash' })
  netDiscrepancy: string;
}

@ObjectType({ description: 'The figures of every rider in the range (not only this page)' })
export class CodCashTotals {
  @Field(() => Int)
  collectionsCount: number;

  @Field(() => MoneyObject)
  collectedTotal: Decimal;

  @Field(() => Int)
  outstandingCount: number;

  @Field(() => MoneyObject)
  outstandingTotal: Decimal;

  @Field(() => Int)
  remittancesCount: number;

  @Field(() => MoneyObject)
  remittedTotal: Decimal;

  @Field(() => Int)
  discrepancyCount: number;

  @Field(() => MoneyObject)
  shortTotal: Decimal;

  @Field(() => MoneyObject)
  overTotal: Decimal;

  @Field(() => String)
  netDiscrepancy: string;
}

@ObjectType({ description: 'A cash-on-delivery order delivered with no cash collection recorded' })
export class CodUncollectedDelivery {
  @Field(() => ID)
  orderId: string;

  @Field(() => Int)
  orderNumber: number;

  @Field(() => MoneyObject)
  grandTotal: Decimal;

  @Field(() => GraphQLISODateTime)
  deliveredAt: Date;
}

@ObjectType({
  description: 'Cash-on-delivery orders delivered in the range without a cash collection (cash not recorded)',
})
export class CodUncollectedDeliveries {
  @Field(() => Int)
  count: number;

  @Field(() => MoneyObject)
  total: Decimal;

  @Field(() => [CodUncollectedDelivery], { description: 'The oldest 100, by delivery time' })
  orders: CodUncollectedDelivery[];
}

@ObjectType({ description: 'Cash-on-delivery cash per rider for a date range' })
export class CodCashReport {
  @Field(() => GraphQLISODateTime)
  from: Date;

  @Field(() => GraphQLISODateTime)
  to: Date;

  @Field(() => [CodRiderCashSummary], { description: 'Riders with collections or remittances in the range, by id' })
  riders: CodRiderCashSummary[];

  @Field(() => PageInfo)
  pageInfo: PageInfo;

  @Field(() => CodCashTotals)
  totals: CodCashTotals;

  @Field(() => CodUncollectedDeliveries, { description: 'Store-wide; not filtered by rider' })
  uncollectedDeliveries: CodUncollectedDeliveries;
}
