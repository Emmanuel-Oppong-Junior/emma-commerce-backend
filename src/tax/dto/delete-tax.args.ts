import { ArgsType, Field, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsString } from 'class-validator';
import { PriceChangeReasonField } from '../../price-history/dto/price-change-reason.field';

@ArgsType()
export class DeleteTaxArgs {
  @Field(() => ID)
  @IsString()
  @IsNotEmpty()
  id: string;

  @PriceChangeReasonField()
  priceChangeReason?: string;
}
