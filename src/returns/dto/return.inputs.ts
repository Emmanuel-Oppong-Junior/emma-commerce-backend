import { ArgsType, Field, ID, InputType, Int } from '@nestjs/graphql';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
import { LotInput } from '../../inventory/lots/dto/lot.input';
import { SerialsField } from '../../inventory/serials/dto/serials.field';
import { MAX_RETURN_LINES, RETURN_PHOTO_LIMIT } from '../return-rules';
import { ReturnReason, ReturnResolution, ReturnStatus } from '../enums/return.enums';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

@InputType()
export class ReturnLineInput {
  @Field(() => ID)
  @IsString()
  orderItemId: string;

  @Field(() => Int, { description: 'Units to return: at most those delivered and not yet refunded or returned' })
  @IsInt()
  @Min(1)
  quantity: number;

  @Field(() => ReturnReason)
  @IsEnum(ReturnReason)
  reason: ReturnReason;

  @Field({ nullable: true, description: 'Required when reason is OTHER' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @Field(() => [String], {
    nullable: true,
    description: `Public ids from POST /returns/orders/:orderId/photos, at most ${RETURN_PHOTO_LIMIT}`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RETURN_PHOTO_LIMIT)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  photoPublicIds?: string[];

  @Field(() => ID, {
    nullable: true,
    description: 'resolution EXCHANGE only: the variant wanted instead (same product, same unit price)',
  })
  @IsOptional()
  @IsString()
  exchangeVariantId?: string;
}

@InputType()
export class RequestReturnInput {
  @Field(() => ID)
  @IsString()
  orderId: string;

  @Field(() => ReturnResolution, { defaultValue: ReturnResolution.REFUND })
  @IsEnum(ReturnResolution)
  resolution: ReturnResolution = ReturnResolution.REFUND;

  @Field(() => [ReturnLineInput])
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RETURN_LINES)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineInput)
  lines: ReturnLineInput[];
}

@InputType()
export class AcceptReturnOutsidePolicyInput extends RequestReturnInput {
  @Field({
    description:
      'Why the store takes the units back outside the return window or although their product type is not returnable',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  overrideReason: string;

  @Field({ nullable: true, description: 'Internal note, never shown to the customer' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  staffNote?: string;
}

@InputType()
export class ReturnStepInput {
  @Field(() => ID)
  @IsString()
  returnRequestId: string;

  @Field({ nullable: true, description: 'Internal note, never shown to the customer' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  staffNote?: string;
}

@InputType()
export class RejectReturnInput extends ReturnStepInput {
  @Field({ description: 'Why it is refused; shown to the customer' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}

@InputType()
export class ReceivedReturnLineInput {
  @Field(() => ID)
  @IsString()
  returnLineId: string;

  @Field(() => Int, { description: 'Units that arrived back (0 to the line quantity)' })
  @IsInt()
  @Min(0)
  receivedQuantity: number;
}

@InputType()
export class ReceiveReturnInput extends ReturnStepInput {
  @Field(() => [ReceivedReturnLineInput], { description: 'Every line of the return, once' })
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RETURN_LINES)
  @ValidateNested({ each: true })
  @Type(() => ReceivedReturnLineInput)
  lines: ReceivedReturnLineInput[];
}

@InputType()
export class InspectedReturnLineInput {
  @Field(() => ID)
  @IsString()
  returnLineId: string;

  @Field(() => Int, { description: "Units put back into sellable stock at the order's location" })
  @IsInt()
  @Min(0)
  restockQuantity: number;

  @Field(() => Int, { description: 'Units not resold (damaged, unsellable); no stock is added for them' })
  @IsInt()
  @Min(0)
  writeOffQuantity: number;

  @Field(() => LotInput, {
    nullable: true,
    description:
      "Lot-tracked variants: the existing lot the restocked units go into; else the lots the order's sale drew from",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => LotInput)
  lot?: LotInput;

  @SerialsField('Serial-tracked variants: one serial per restocked unit, each a unit sold on this order')
  serials?: string[];
}

@InputType()
export class InspectReturnInput extends ReturnStepInput {
  @Field(() => [InspectedReturnLineInput], { description: 'Every line with units received, once' })
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RETURN_LINES)
  @ValidateNested({ each: true })
  @Type(() => InspectedReturnLineInput)
  lines: InspectedReturnLineInput[];
}

@InputType()
export class RefundReturnInput extends ReturnStepInput {
  @Field({
    defaultValue: false,
    description:
      'Also refund the delivery fee the order was charged (once per order); not refunded on returns by default',
  })
  @IsBoolean()
  refundShipping: boolean = false;
}

@ArgsType()
export class MyReturnsArgs {
  @Field(() => Int, { defaultValue: 20, description: '1-100' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 20;

  @Field(() => ID, { nullable: true, description: 'Id of the last return of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}

@ArgsType()
export class ReturnsArgs extends MyReturnsArgs {
  @Field(() => ReturnStatus, { nullable: true })
  @IsOptional()
  @IsEnum(ReturnStatus)
  status?: ReturnStatus;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  orderId?: string;

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
}
