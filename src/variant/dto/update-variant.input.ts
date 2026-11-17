import { CreateVariantInput } from './create-variant.input';
import { Field, InputType, OmitType, PartialType } from '@nestjs/graphql';
import { IsNotEmpty } from 'class-validator';

// Stock moves only through restockVariant/adjustVariantStock, so an edit form can't overwrite live stock.
@InputType()
export class UpdateVariantInput extends PartialType(OmitType(CreateVariantInput, ['quantity'] as const)) {
  @Field(() => String)
  @IsNotEmpty({ message: 'Variant ID must not be empty' })
  id: string;
}
