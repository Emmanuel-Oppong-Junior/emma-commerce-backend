import { Field, InputType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsDate, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { MAX_LOT_NUMBER_LENGTH } from '../lots';

@InputType({ description: 'A lot of a lot-tracked variant (P4-C.1), by its number' })
export class LotInput {
  @Field({ description: 'Unique per variant; receiving into an existing lot number adds to it' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_LOT_NUMBER_LENGTH)
  lotNumber: string;

  @Field({
    nullable: true,
    description:
      'When the lot expires; required on a receipt (in the future) and to create a lot, and must match an existing lot',
  })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  expiresAt?: Date;

  @Field({ nullable: true, description: 'Optional; before the expiry and not in the future' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  manufacturedAt?: Date;
}
