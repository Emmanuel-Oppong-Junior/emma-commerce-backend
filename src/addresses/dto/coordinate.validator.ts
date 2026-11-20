import { applyDecorators } from '@nestjs/common';
import { ValidateBy, ValidateIf, ValidationArguments } from 'class-validator';

/**
 * Latitude and longitude are set together or cleared together (both null). A number must lie within ±limit.
 * Validation runs whenever either one is sent, so a lone value or a lone null is rejected.
 */
export function IsCoordinate(property: string, pairedWith: string, limit: number): PropertyDecorator {
  return applyDecorators(
    ValidateIf((object: Record<string, unknown>) => object[property] !== undefined || object[pairedWith] !== undefined),
    ValidateBy({
      name: 'isCoordinate',
      validator: {
        validate(value: unknown, args?: ValidationArguments) {
          const paired = (args?.object as Record<string, unknown>)[pairedWith];
          if (value === null) return paired === null;
          return typeof value === 'number' && Math.abs(value) <= limit && typeof paired === 'number';
        },
        defaultMessage: () =>
          `${property} must be a number from -${limit} to ${limit}, sent together with ${pairedWith} (or both null to clear them)`,
      },
    }),
  );
}
