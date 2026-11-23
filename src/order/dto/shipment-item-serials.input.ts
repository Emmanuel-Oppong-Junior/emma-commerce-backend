import { Field, ID, InputType } from '@nestjs/graphql';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, MaxLength } from 'class-validator';
import { MAX_SERIALS_PER_CHANGE } from '../../inventory/serials/dto/serials.field';

@InputType()
export class ShipmentItemSerialsInput {
  @Field(() => ID, { description: 'The shipment line (ShipmentItem) the units were picked for' })
  @IsString()
  shipmentItemId: string;

  @Field(() => [String], { description: 'Serials as typed or scanned; normalised by the product’s serial format' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SERIALS_PER_CHANGE)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  serials: string[];
}
