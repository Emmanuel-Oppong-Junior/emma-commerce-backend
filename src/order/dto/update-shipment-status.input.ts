import { Field, ID, InputType } from '@nestjs/graphql';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ShipmentStatusEnum } from '../enums/order.enum';

@InputType()
export class UpdateShipmentStatusInput {
  @Field(() => ID, { description: 'The order whose shipment moves (one shipment per order for now)' })
  @IsNotEmpty()
  orderId: string;

  @Field(() => ShipmentStatusEnum, { description: 'The next fulfilment step' })
  @IsEnum(ShipmentStatusEnum)
  status: ShipmentStatusEnum;

  @Field({ nullable: true, description: 'Shown in the history and audit log, e.g. why a delivery failed' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
