import { ArgsType, Field, ID, InputType, Int } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PurchaseOrderStatus } from '../../generated/prisma/client';
import { DecimalInputField, IsUnitCost } from '../../commons/money/decimal.scalar';
import { LotInput } from '../../inventory/lots/dto/lot.input';
import { SerialsField } from '../../inventory/serials/dto/serials.field';
import { MAX_PURCHASE_ORDER_LINES } from './purchase-order-rules';

@InputType()
export class PurchaseOrderLineInput {
  @Field(() => ID)
  @IsString()
  variantId: string;

  @Field(() => Int, { description: 'Units ordered, at least 1' })
  @IsInt()
  @Min(1)
  quantity: number;

  @DecimalInputField({ description: 'Tax-exclusive cost of one unit in the store currency, at most 4 decimal places' })
  @IsUnitCost()
  unitCost: Decimal;
}

@InputType()
export class CreatePurchaseOrderInput {
  @Field(() => ID, { description: 'An active supplier' })
  @IsString()
  supplierId: string;

  @Field(() => ID, { description: 'The active stock location the goods are received at' })
  @IsString()
  locationId: string;

  @Field({ nullable: true, description: 'When the supplier should deliver' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  expectedAt?: Date;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @Field(() => [PurchaseOrderLineInput], { description: `1-${MAX_PURCHASE_ORDER_LINES} lines, one per variant` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PURCHASE_ORDER_LINES)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineInput)
  lines: PurchaseOrderLineInput[];
}

@InputType({
  description:
    'Fields left out stay as they are. Supplier, location and lines change only in DRAFT (lines given replace them ' +
    'all); the expected date and note until the order is final',
})
export class UpdatePurchaseOrderInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  supplierId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  locationId?: string;

  @Field(() => Date, { nullable: true, description: 'null clears it' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  expectedAt?: Date | null;

  @Field(() => String, { nullable: true, description: 'null clears it' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;

  @Field(() => [PurchaseOrderLineInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PURCHASE_ORDER_LINES)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineInput)
  lines?: PurchaseOrderLineInput[];
}

@InputType()
export class ReceivePurchaseOrderLineInput {
  @Field(() => ID)
  @IsString()
  variantId: string;

  @Field(() => Int, { description: 'Units arriving now: at least 1, at most what is outstanding' })
  @IsInt()
  @Min(1)
  quantity: number;

  @Field(() => LotInput, {
    nullable: true,
    description: 'Lot-tracked variants only, and required for them: lot number and expiry (in the future)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => LotInput)
  lot?: LotInput;

  @SerialsField('Serial-tracked variants only, and required for them: one new serial per unit')
  serials?: string[];
}

@InputType()
export class ReceivePurchaseOrderInput {
  @Field(() => [ReceivePurchaseOrderLineInput], { description: 'The lines in this delivery' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PURCHASE_ORDER_LINES)
  @ValidateNested({ each: true })
  @Type(() => ReceivePurchaseOrderLineInput)
  lines: ReceivePurchaseOrderLineInput[];

  @Field({ nullable: true, description: 'E.g. the delivery note number' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

@InputType()
export class CancelPurchaseOrderInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}

@InputType()
export class ClosePurchaseOrderInput {
  @Field({ description: 'Why the outstanding units will not arrive' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

@ArgsType()
export class PurchaseOrdersArgs {
  @Field(() => PurchaseOrderStatus, { nullable: true })
  @IsOptional()
  @IsEnum(PurchaseOrderStatus)
  status?: PurchaseOrderStatus;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  supplierId?: string;

  @Field(() => ID, { nullable: true, description: 'Orders received at this location' })
  @IsOptional()
  @IsString()
  locationId?: string;

  @Field(() => ID, { nullable: true, description: 'Orders with a line of this variant' })
  @IsOptional()
  @IsString()
  variantId?: string;

  @Field({ nullable: true, description: 'Created at or after' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  createdFrom?: Date;

  @Field({ nullable: true, description: 'Created before' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  createdTo?: Date;

  @Field(() => Int, { defaultValue: 50, description: '1-100' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 50;

  @Field(() => ID, { nullable: true, description: 'Id of the last purchase order of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}
