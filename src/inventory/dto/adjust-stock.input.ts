import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, NotEquals } from 'class-validator';

@InputType()
export class AdjustVariantStockInput {
  @Field(() => ID)
  @IsString()
  variantId: string;

  @Field(() => Int, { description: 'Signed change: negative removes stock (damage, loss, count), positive adds it' })
  @IsInt()
  @NotEquals(0)
  delta: number;

  @Field({ description: 'Why the stock changed' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;

  @Field(() => ID, {
    nullable: true,
    description: 'Where the stock changes; defaults to the default location',
  })
  @IsOptional()
  @IsString()
  locationId?: string;
}
