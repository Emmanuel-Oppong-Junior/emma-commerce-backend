import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { MoneyObject } from '../../../commons/money/money.object';

@ObjectType({ description: 'Units of a lot at one stock location' })
export class LotLocationStock {
  @Field(() => ID)
  locationId: string;

  @Field()
  locationName: string;

  @Field(() => Int)
  onHand: number;
}

@ObjectType({ description: 'A batch of a lot-tracked variant with its expiry (P4-C.1)' })
export class Lot {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  variantId: string;

  @Field({ description: 'Unique per variant' })
  lotNumber: string;

  @Field({ description: 'From this instant the units are not sold; the hourly expiry job writes them off' })
  expiresAt: Date;

  @Field(() => Date, { nullable: true })
  manufacturedAt: Date | null;

  @Field({ description: 'When the lot was first received' })
  createdAt: Date;

  @Field({ description: 'Whether the lot has expired' })
  expired: boolean;

  @Field(() => Int, { description: 'Units on hand over every location' })
  onHand: number;

  @Field(() => [LotLocationStock], { description: 'Locations holding units of the lot' })
  stock: LotLocationStock[];
}

@ObjectType({ description: 'A lot with stock expiring soon (or already expired), for the expiring-stock report' })
export class ExpiringStockLine {
  @Field(() => ID)
  lotId: string;

  @Field()
  lotNumber: string;

  @Field()
  expiresAt: Date;

  @Field(() => Date, { nullable: true })
  manufacturedAt: Date | null;

  @Field({ description: 'Expired and not yet written off (units held for orders, or before the next expiry run)' })
  expired: boolean;

  @Field(() => ID)
  variantId: string;

  @Field()
  sku: string;

  @Field(() => ID)
  productId: string;

  @Field()
  productName: string;

  @Field(() => [LotLocationStock], { description: 'Units per location, by location name' })
  locations: LotLocationStock[];

  @Field(() => Int, { description: 'Units on hand over the locations listed' })
  onHand: number;

  @Field(() => MoneyObject, { nullable: true, description: 'The variant’s current selling price' })
  unitPrice: Decimal | null;

  @Field(() => MoneyObject, {
    nullable: true,
    description: 'onHand at the current selling price (cost value comes with purchasing); null when unpriced',
  })
  value: Decimal | null;
}
