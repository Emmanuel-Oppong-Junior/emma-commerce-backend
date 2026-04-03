import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { InventoryActionEnum } from '../enums/inventory-action.enum';
import { InventoryAction } from '@prisma/client';

@ObjectType()
export class InventoryLogEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  productId: string;

  @Field(() => ID, { nullable: true })
  variantId?: string;

  @Field(() => InventoryActionEnum)
  action: InventoryAction;

  @Field(() => Int)
  quantityChange: number;

  @Field(() => Int)
  quantityAfter: number;

  @Field({ nullable: true })
  reason?: string;

  @Field(() => ID, { nullable: true })
  actorId?: string;

  @Field()
  createdAt: Date;
}
