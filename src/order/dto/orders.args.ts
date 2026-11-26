import { ArgsType, Field, ID, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { OrderStatus } from '../../generated/prisma/client';
import { OrderStatusEnum } from '../enums/order.enum';

export const MAX_ORDERS_PAGE = 100;

@ArgsType()
export class OrdersArgs {
  @Field(() => Int, { defaultValue: 20, description: `1-${MAX_ORDERS_PAGE}` })
  @IsInt()
  @Min(1)
  @Max(MAX_ORDERS_PAGE)
  first: number = 20;

  @Field(() => ID, { nullable: true, description: 'Id of the last order of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;

  @Field(() => OrderStatusEnum, { nullable: true })
  @IsOptional()
  @IsEnum(OrderStatusEnum)
  status?: OrderStatus;
}
