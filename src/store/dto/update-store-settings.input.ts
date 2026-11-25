import { Field, InputType, Int } from '@nestjs/graphql';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
// Omitted means unchanged; null is validated (and rejected) because these columns cannot be cleared.
const unlessOmitted = ValidateIf((_: object, value: unknown) => value !== undefined);

@InputType({ description: 'Store settings to change; omitted fields keep their value, null clears an optional one' })
export class UpdateStoreSettingsInput {
  @Field(() => String, { nullable: true, description: 'Registered legal name, as printed on receipts' })
  @unlessOmitted
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'legalName must not be blank' })
  @MaxLength(200)
  legalName?: string;

  @Field(() => String, { nullable: true, description: 'Name customers see' })
  @unlessOmitted
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'tradingName must not be blank' })
  @MaxLength(200)
  tradingName?: string;

  // Ghana Card PINs used as TINs contain hyphens (GHA-123456789-0), so they are allowed alongside letters and digits.
  @Field(() => String, { nullable: true, description: 'Taxpayer Identification Number (letters, digits, hyphens)' })
  @IsOptional()
  @Transform(trim)
  @Matches(/^[A-Za-z0-9-]{1,20}$/, { message: 'tin must be 1-20 letters, digits or hyphens' })
  tin?: string | null;

  @Field(() => Boolean, { nullable: true })
  @unlessOmitted
  @IsBoolean()
  vatRegistered?: boolean;

  @Field(() => Boolean, { nullable: true, description: 'Whether product prices already include tax' })
  @unlessOmitted
  @IsBoolean()
  pricesIncludeTax?: boolean;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsEmail({}, { message: 'supportEmail must be a valid email address' })
  @MaxLength(254)
  supportEmail?: string | null;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsPhoneNumber(undefined, { message: 'supportPhone must be a valid phone number in international format' })
  supportPhone?: string | null;

  @Field(() => Int, {
    nullable: true,
    description: 'Days after delivery goods may be returned in (0-365), unless their product type sets its own',
  })
  @unlessOmitted
  @IsInt()
  @Min(0)
  @Max(365)
  returnWindowDays?: number;

  @Field(() => Int, {
    nullable: true,
    description:
      'Hours a signed-in customer’s cart sits unchanged before the abandoned-cart reminder (1-72; default 4)',
  })
  @unlessOmitted
  @IsInt()
  @Min(1)
  @Max(72)
  abandonedCartReminderDelayHours?: number;
}
