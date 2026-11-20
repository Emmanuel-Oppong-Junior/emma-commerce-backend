import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ValidateBy, ValidationOptions } from 'class-validator';

export const GHANA_PHONE_FORMATS_DESCRIPTION =
  'Ghana number as 0XXXXXXXXX, 233XXXXXXXXX, +233XXXXXXXXX or 00233XXXXXXXXX (spaces, dashes, dots and parentheses ' +
  'are ignored); stored as +233XXXXXXXXX';

const SEPARATORS = /[\s\-.()]/g;
const GHANA_PHONE = /^(?:0|233|\+233|00233)([1-9]\d{8})$/;

/** Returns the number in E.164 form (`+233` and nine digits), or null when it is not a Ghana number. */
export function normaliseGhanaPhone(input: string): string | null {
  const match = GHANA_PHONE.exec(input.replace(SEPARATORS, ''));
  return match ? `+233${match[1]}` : null;
}

/**
 * Normalises a Ghana phone number to E.164 and rejects anything else. Leaves null and undefined to the field's
 * optional/required rules.
 */
export function IsGhanaPhone(options?: ValidationOptions): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? (normaliseGhanaPhone(value) ?? value) : value,
    ),
    ValidateBy(
      {
        name: 'isGhanaPhone',
        validator: {
          validate: (value: unknown) => typeof value === 'string' && normaliseGhanaPhone(value) === value,
          defaultMessage: () => `$property must be a ${GHANA_PHONE_FORMATS_DESCRIPTION}`,
        },
      },
      options,
    ),
  );
}
