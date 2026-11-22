import { ArgsType, Field, ID, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
import { StockTransferStatus } from '../../generated/prisma/client';
import { MAX_TRANSFER_LINES } from './stock-transfer-rules';

@InputType()
export class StockTransferLineInput {
  @Field(() => ID)
  @IsString()
  variantId: string;

  @Field(() => Int, { description: 'Units to send, at least 1' })
  @IsInt()
  @Min(1)
  quantity: number;
}

@InputType()
export class CreateStockTransferInput {
  @Field(() => ID)
  @IsString()
  fromLocationId: string;

  @Field(() => ID)
  @IsString()
  toLocationId: string;

  @Field(() => [StockTransferLineInput], { description: `1-${MAX_TRANSFER_LINES} lines, one per variant` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_TRANSFER_LINES)
  @ValidateNested({ each: true })
  @Type(() => StockTransferLineInput)
  lines: StockTransferLineInput[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

@InputType()
export class ReceivedTransferLineInput {
  @Field(() => ID)
  @IsString()
  variantId: string;

  @Field(() => Int, { description: 'Units that arrived, 0 to the quantity dispatched' })
  @IsInt()
  @Min(0)
  receivedQuantity: number;

  @Field({ nullable: true, description: 'Required when fewer units arrived than were dispatched' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

@InputType()
export class ReceiveStockTransferInput {
  @Field(() => [ReceivedTransferLineInput], {
    nullable: true,
    description: 'Only lines that arrived short; every other line is received in full',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TRANSFER_LINES)
  @ValidateNested({ each: true })
  @Type(() => ReceivedTransferLineInput)
  lines?: ReceivedTransferLineInput[];
}

@InputType()
export class CancelStockTransferInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}

@ArgsType()
export class StockTransfersArgs {
  @Field(() => StockTransferStatus, { nullable: true })
  @IsOptional()
  @IsEnum(StockTransferStatus)
  status?: StockTransferStatus;

  @Field(() => ID, { nullable: true, description: 'Transfers leaving or arriving at this location' })
  @IsOptional()
  @IsString()
  locationId?: string;

  @Field(() => ID, { nullable: true, description: 'Transfers with a line of this variant' })
  @IsOptional()
  @IsString()
  variantId?: string;

  @Field(() => Int, { defaultValue: 50, description: '1-100' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 50;

  @Field(() => ID, { nullable: true, description: 'Id of the last transfer of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}
