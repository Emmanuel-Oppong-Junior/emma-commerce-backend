import { Field, Float, ID, InputType } from '@nestjs/graphql';
import { Transform } from 'class-transformer';
import { IsLatitude, IsLongitude, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Decimal } from '@prisma/client/runtime/client';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

@InputType({ isAbstract: true })
class DeliveryDetailsInput {
  @Field(() => ID)
  @IsNotEmpty()
  shipmentId: string;

  @Field({ nullable: true, description: 'Public id returned by the delivery photo upload for this shipment' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  photoPublicId?: string;

  @Field({ nullable: true, description: 'Who took the goods, when not the customer' })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(120)
  recipientName?: string;

  @Field(() => Float, { nullable: true, description: 'Where it was delivered: latitude (kept to 6 decimals)' })
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @Field(() => Float, { nullable: true, description: 'Longitude (send with latitude)' })
  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @DecimalInputField({
    nullable: true,
    description:
      'Cash on delivery: the cash collected, which must be the order total. Required for COD, refused otherwise',
  })
  @IsOptional()
  @IsMoneyAmount()
  cashCollected?: Decimal;
}

@InputType()
export class CompleteMyDeliveryInput extends DeliveryDetailsInput {
  @Field({ description: 'The six-digit code the customer received by SMS when the shipment went out' })
  @IsString()
  @Transform(trim)
  @IsNotEmpty()
  @MaxLength(12)
  code: string;
}

@InputType()
export class CompleteDeliveryInput extends DeliveryDetailsInput {
  @Field({ nullable: true, description: 'The customer’s delivery code; or send overrideReason instead' })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(12)
  code?: string;

  @Field({
    nullable: true,
    description: 'Confirm without the code (needs delivery.override): why, e.g. the customer has no phone',
  })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(500)
  overrideReason?: string;
}
