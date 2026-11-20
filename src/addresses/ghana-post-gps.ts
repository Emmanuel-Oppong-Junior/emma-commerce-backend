import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ValidateBy } from 'class-validator';

export const GHANA_POST_GPS_DESCRIPTION =
  'GhanaPostGPS digital address: two letters, 3-4 digits, then 4 digits, hyphens optional (GA1234567, ga-123-4567, ' +
  'AK-484-9321); stored as XX-NNN(N)-NNNN';

const GHANA_POST_GPS = /^([A-Z]{2})-?(\d{3,4})-?(\d{4})$/;

/** Returns the canonical `XX-NNN(N)-NNNN` form, or null when the text is not a GhanaPostGPS address. */
export function normaliseGhanaPostGps(input: string): string | null {
  const match = GHANA_POST_GPS.exec(input.trim().toUpperCase().replace(/\s+/g, ''));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function IsGhanaPostGps(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? (normaliseGhanaPostGps(value) ?? value) : value,
    ),
    ValidateBy({
      name: 'isGhanaPostGps',
      validator: {
        validate: (value: unknown) => typeof value === 'string' && normaliseGhanaPostGps(value) === value,
        defaultMessage: () => `$property must be a ${GHANA_POST_GPS_DESCRIPTION}`,
      },
    }),
  );
}
