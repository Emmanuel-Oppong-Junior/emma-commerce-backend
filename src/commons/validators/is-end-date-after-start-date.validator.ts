import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

/**
 * Field-level decorator that validates a date field is strictly after a named sibling field.
 * Apply to the end-date field and pass the name of the start-date field as the argument.
 *
 * Works on partial inputs (e.g. UpdateDiscountInput): if the start-date sibling is absent,
 * validation is skipped so partial updates are not blocked.
 *
 * @example
 *   @IsEndDateAfterStartDate('startDate')
 *   endDate: Date;
 */
export function IsEndDateAfterStartDate(startDateProperty: string, options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isEndDateAfterStartDate',
      target: object.constructor,
      propertyName,
      constraints: [startDateProperty],
      options: {
        message: `$property must be after ${startDateProperty}`,
        ...options,
      },
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const [relatedProp] = args.constraints as [string];
          const startDate = (args.object as Record<string, unknown>)[relatedProp];
          if (!(startDate instanceof Date)) return true; // startDate absent — skip
          return value instanceof Date && value > startDate;
        },
      },
    });
  };
}
