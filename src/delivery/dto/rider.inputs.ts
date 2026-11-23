import { ArgsType, Field, ID, InputType, Int } from '@nestjs/graphql';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ShipmentStatus } from '../../generated/prisma/client';
import { ShipmentStatusEnum } from '../../order/enums/order.enum';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

@InputType()
export class AssignShipmentRiderInput {
  @Field(() => ID)
  @IsNotEmpty()
  shipmentId: string;

  @Field(() => ID, { description: 'An active staff member whose role holds delivery.ride' })
  @IsNotEmpty()
  riderId: string;

  @Field({ nullable: true, description: 'Required to replace the rider once the shipment has been dispatched' })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(500)
  reason?: string;
}

@InputType()
export class UnassignShipmentRiderInput {
  @Field(() => ID)
  @IsNotEmpty()
  shipmentId: string;

  @Field({ nullable: true, description: 'Required after a failed delivery attempt' })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(500)
  reason?: string;
}

@ArgsType()
export class MyDeliveriesArgs {
  @Field(() => [ShipmentStatusEnum], {
    nullable: true,
    description: 'Only these statuses; omitted: the open ones (not delivered, returned or cancelled)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsEnum(ShipmentStatus, { each: true })
  status?: ShipmentStatus[];

  @Field({
    nullable: true,
    description: 'A day (YYYY-MM-DD, UTC = Ghana time): only shipments assigned, dispatched or delivered that day',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be a day as YYYY-MM-DD' })
  date?: string;

  @Field(() => Int, { defaultValue: 50, description: 'At most this many (1-100), oldest assignment first' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 50;
}

@InputType()
export class FailMyDeliveryInput {
  @Field(() => ID)
  @IsNotEmpty()
  shipmentId: string;

  @Field({ description: 'What happened (customer not reachable, wrong address, refused...); shown to staff' })
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
