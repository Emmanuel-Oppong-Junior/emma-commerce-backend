import { BadRequestException, ValidationError, ValidationPipe } from '@nestjs/common';

export class InputValidationException extends BadRequestException {}

function messagesOf(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {});
    return own.length > 0 ? own : messagesOf(error.children ?? [], path);
  });
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
    exceptionFactory: (errors) => new InputValidationException(messagesOf(errors)),
  });
}
