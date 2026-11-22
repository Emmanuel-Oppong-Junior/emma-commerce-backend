import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { StockLocationType } from '../../generated/prisma/client';

registerEnumType(StockLocationType, { name: 'StockLocationType', description: 'What kind of place holds the stock' });

@ObjectType({ description: 'A place that holds stock: warehouse, branch or pickup point (staff)' })
export class StockLocation {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field(() => StockLocationType)
  type: StockLocationType;

  @Field({ description: 'Inactive: never chosen to fulfil new orders, and its stock is not shown to customers' })
  isActive: boolean;

  @Field({ description: 'Fulfils shipping zones and pickup points with no list of their own; always active' })
  isDefault: boolean;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType({ description: 'Stock of a variant at one location (staff)' })
export class VariantStockLevel {
  @Field(() => ID)
  locationId: string;

  @Field()
  locationName: string;

  @Field(() => Int)
  onHand: number;

  @Field(() => Int)
  reserved: number;

  @Field(() => Int, { description: 'onHand - reserved' })
  available: number;
}
