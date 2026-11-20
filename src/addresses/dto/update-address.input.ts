import { CreateAddressInput } from './create-address.input';
import { InputType, PartialType } from '@nestjs/graphql';

// skipNullProperties: false keeps validating an explicit null, so null on a required field (street, region, ...) is
// rejected instead of reaching the database; optional fields keep their own @IsOptional and accept null to clear.
@InputType()
export class UpdateAddressInput extends PartialType(CreateAddressInput, {
  skipNullProperties: false,
  omitDefaultValues: true,
}) {}
