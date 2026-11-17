import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ImATeapotException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { classifyError } from './error-classification';
import { InputValidationException } from '../validation-pipe';

const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('Invalid `prisma.order.delete()` invocation: secret table details', {
    code,
    clientVersion: 'test',
    meta,
  });

describe('classifyError', () => {
  it.each([
    [new BadRequestException('Insufficient stock'), 400, 'BAD_REQUEST', 'Insufficient stock'],
    [new UnauthorizedException('Invalid email or password'), 401, 'UNAUTHENTICATED', 'Invalid email or password'],
    [new ForbiddenException('Not yours'), 403, 'FORBIDDEN', 'Not yours'],
    [new NotFoundException('Product not found'), 404, 'NOT_FOUND', 'Product not found'],
    [new ConflictException('SKU in use'), 409, 'CONFLICT', 'SKU in use'],
    [new ImATeapotException('teapot'), 418, 'BAD_REQUEST', 'teapot'],
  ])('maps %p to its GraphQL code', (exception, status, code, message) => {
    expect(classifyError(exception)).toEqual({ status, code, message });
  });

  it('labels ValidationPipe failures BAD_USER_INPUT and joins their messages', () => {
    const exception = new InputValidationException(['email must be an email', 'name is too short']);

    expect(classifyError(exception)).toEqual({
      status: 400,
      code: 'BAD_USER_INPUT',
      message: 'email must be an email; name is too short',
    });
  });

  it('hides the message of server errors', () => {
    expect(classifyError(new InternalServerErrorException('db password is wrong'))).toEqual({
      status: 500,
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
    expect(classifyError(new Error('boom'))).toEqual({
      status: 500,
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
  });

  it('maps a unique-constraint violation (P2002) to CONFLICT naming the field', () => {
    expect(classifyError(prismaError('P2002', { target: ['sku'] }))).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'A record with this sku already exists',
    });
  });

  it('maps a foreign-key violation (P2003) to CONFLICT without Prisma details', () => {
    const result = classifyError(prismaError('P2003', { field_name: 'ReturnRequest_orderId_fkey' }));

    expect(result).toEqual({
      status: 409,
      code: 'CONFLICT',
      message: 'This record is referenced by other records and cannot be changed or removed',
    });
  });

  it('maps a missing record (P2025) to NOT_FOUND', () => {
    expect(classifyError(prismaError('P2025'))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Record not found',
    });
  });

  it('treats other Prisma errors as internal', () => {
    expect(classifyError(prismaError('P1001'))).toEqual({
      status: 500,
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
  });
});
