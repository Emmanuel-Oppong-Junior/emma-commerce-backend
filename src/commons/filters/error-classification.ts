import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InputValidationException } from '../validation-pipe';

export interface ClassifiedError {
  status: number;
  code: string;
  message: string;
}

const CODE_BY_STATUS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
};

const INTERNAL: ClassifiedError = {
  status: HttpStatus.INTERNAL_SERVER_ERROR,
  code: 'INTERNAL_SERVER_ERROR',
  message: 'Internal server error',
};

function classifyPrisma(error: Prisma.PrismaClientKnownRequestError): ClassifiedError {
  switch (error.code) {
    case 'P2002': {
      const target = error.meta?.target;
      const fields = Array.isArray(target) ? target.join(', ') : typeof target === 'string' ? target : undefined;
      return {
        status: HttpStatus.CONFLICT,
        code: 'CONFLICT',
        message: fields ? `A record with this ${fields} already exists` : 'A record with these values already exists',
      };
    }
    case 'P2003':
      return {
        status: HttpStatus.CONFLICT,
        code: 'CONFLICT',
        message: 'This record is referenced by other records and cannot be changed or removed',
      };
    case 'P2025':
      return { status: HttpStatus.NOT_FOUND, code: 'NOT_FOUND', message: 'Record not found' };
    default:
      return INTERNAL;
  }
}

function httpMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join('; ');
  return typeof message === 'string' ? message : exception.message;
}

// Prisma's own messages include query and table details, so they are never returned to clients.
export function classifyError(exception: unknown): ClassifiedError {
  if (exception instanceof Prisma.PrismaClientKnownRequestError) return classifyPrisma(exception);
  if (exception instanceof InputValidationException) {
    return { status: exception.getStatus(), code: 'BAD_USER_INPUT', message: httpMessage(exception) };
  }
  if (!(exception instanceof HttpException)) return INTERNAL;
  const status = exception.getStatus();
  if (status >= HttpStatus.INTERNAL_SERVER_ERROR) return { ...INTERNAL, status };
  return { status, code: CODE_BY_STATUS[status] ?? 'BAD_REQUEST', message: httpMessage(exception) };
}
