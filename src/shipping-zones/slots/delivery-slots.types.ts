import { Field, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateIf } from 'class-validator';
import { OrderStatus } from '../../generated/prisma/client';
import { Weekday } from '../enums/delivery.enums';
import { OrderStatusEnum } from '../../order/enums/order.enum';

const TIME = /^\d{2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const unlessOmitted = ValidateIf((_: object, value: unknown) => value !== undefined);

@InputType({ description: 'A weekly delivery window; times are HH:MM in Africa/Accra (= UTC), "24:00" ends the day' })
export class CreateDeliverySlotInput {
  @Field(() => Weekday)
  @IsEnum(Weekday)
  weekday: Weekday;

  @Field()
  @Matches(TIME, { message: 'startTime must be HH:MM' })
  startTime: string;

  @Field()
  @Matches(TIME, { message: 'endTime must be HH:MM' })
  endTime: string;

  @Field(() => Int, { description: 'Orders per date' })
  @IsInt()
  @Min(1)
  capacity: number;

  @Field(() => Int, { nullable: true, defaultValue: 0, description: 'Bookable until this many hours before start' })
  @IsOptional()
  @IsInt()
  @Min(0)
  cutoffHours?: number;

  @Field({ nullable: true, defaultValue: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

@InputType({ description: 'Slot fields to change; omitted fields keep their value' })
export class UpdateDeliverySlotInput {
  @Field({ nullable: true })
  @unlessOmitted
  @Matches(TIME, { message: 'startTime must be HH:MM' })
  startTime?: string;

  @Field({ nullable: true })
  @unlessOmitted
  @Matches(TIME, { message: 'endTime must be HH:MM' })
  endTime?: string;

  @Field(() => Int, { nullable: true })
  @unlessOmitted
  @IsInt()
  @Min(1)
  capacity?: number;

  @Field(() => Int, { nullable: true })
  @unlessOmitted
  @IsInt()
  @Min(0)
  cutoffHours?: number;

  @Field({ nullable: true })
  @unlessOmitted
  @IsBoolean()
  isActive?: boolean;
}

@InputType()
export class DeliveryClosureInput {
  @Field({ description: 'YYYY-MM-DD' })
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

@InputType({ description: 'The delivery slot chosen at checkout: one of checkoutQuote.deliverySlots' })
export class DeliverySlotChoiceInput {
  @Field(() => ID)
  @IsString()
  slotId: string;

  @Field({ description: 'YYYY-MM-DD' })
  @Matches(DATE, { message: 'date must be YYYY-MM-DD' })
  date: string;
}

@ObjectType()
export class DeliverySlotEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  zoneId: string;

  @Field(() => Weekday)
  weekday: Weekday;

  @Field({ description: 'HH:MM, Africa/Accra' })
  startTime: string;

  @Field({ description: 'HH:MM, Africa/Accra' })
  endTime: string;

  @Field(() => Int)
  capacity: number;

  @Field(() => Int)
  cutoffHours: number;

  @Field()
  isActive: boolean;
}

@ObjectType()
export class DeliveryClosureEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  zoneId: string;

  @Field({ description: 'YYYY-MM-DD' })
  date: string;

  @Field(() => String, { nullable: true })
  reason: string | null;
}

@ObjectType({ description: 'A delivery window on a date' })
export class DeliveryWindow {
  @Field(() => ID)
  slotId: string;

  @Field({ description: 'YYYY-MM-DD' })
  date: string;

  @Field({ description: 'HH:MM, Africa/Accra' })
  startTime: string;

  @Field({ description: 'HH:MM, Africa/Accra' })
  endTime: string;
}

@ObjectType({ description: 'A slot checkout can book' })
export class AvailableDeliverySlot extends DeliveryWindow {
  @Field(() => Int, { description: 'Places left; 0 when full' })
  remaining: number;
}

@ObjectType()
export class BookedOrder {
  @Field(() => ID)
  orderId: string;

  @Field(() => Int)
  orderNumber: number;

  @Field(() => OrderStatusEnum)
  status: OrderStatus;
}

@ObjectType({ description: 'A slot booked on a date, with the orders holding its places' })
export class DeliveryBooking extends DeliveryWindow {
  @Field(() => ID)
  zoneId: string;

  @Field()
  zoneName: string;

  @Field(() => Int)
  capacity: number;

  @Field(() => Int)
  booked: number;

  @Field(() => [BookedOrder])
  orders: BookedOrder[];
}
