import { Field, ID, InputType } from '@nestjs/graphql';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, MaxLength } from 'class-validator';
import { MAX_SERIALS_PER_CHANGE } from '../../inventory/serials/dto/serials.field';

@InputType()
export class OrderItemSerialsInput {
  @Field(() => ID)
  @IsString()
  orderItemId: string;

  @Field(() => [String], { description: 'Serials as typed or scanned; normalised by the product’s serial format' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SERIALS_PER_CHANGE)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  serials: string[];
}
