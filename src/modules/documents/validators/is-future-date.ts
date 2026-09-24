import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * The value must be a parsable date/timestamp strictly in the future.
 *
 * Client-side `min` attributes on a date input are advisory — anyone can edit
 * the DOM or post straight to the API — so a "must be in the future" rule has
 * to be re-checked here.
 */
export function IsFutureDate(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isFutureDate',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          const time = Date.parse(value);
          return Number.isFinite(time) && time > Date.now();
        },
        defaultMessage() {
          return `${propertyName} must be a date in the future`;
        },
      },
    });
  };
}
