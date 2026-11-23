import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

@InputType()
export class ShipmentItemInput {
  @Field(() => ID)
  @IsString()
  orderItemId: string;

  @Field(() => Int, { description: 'Units of the order line in this shipment (at most its unshipped units)' })
  @IsInt()
  @Min(1)
  quantity: number;
}

@InputType()
export class CreateShipmentInput {
  @Field(() => ID)
  @IsNotEmpty()
  orderId: string;

  @Field(() => [ShipmentItemInput], {
    nullable: true,
    description:
      'The order lines and units to ship; omitted: every unit not yet in a shipment. A cash-on-delivery order is ' +
      'never split (its one shipment carries every unit)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ShipmentItemInput)
  items?: ShipmentItemInput[];
}

@InputType()
export class CancelShipmentInput {
  @Field(() => ID)
  @IsNotEmpty()
  shipmentId: string;

  @Field({ nullable: true, description: 'Shown in the shipment history and audit log' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
