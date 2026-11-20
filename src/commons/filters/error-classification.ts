import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { InputValidationException } from '../validation-pipe';

export interface ClassifiedError {
  status: number;
  code: string;
  message: string;
  /** Extra GraphQL extensions an HttpException carries as `{ extensions }` in its response (e.g. `reason`). */
  extensions?: Record<string, unknown>;
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

/** The error code a response with this HTTP status stands for, as classifyError assigns it. */
export function errorCodeForStatus(status: number): string {
  if (status >= HttpStatus.INTERNAL_SERVER_ERROR) return INTERNAL.code;
  return CODE_BY_STATUS[status] ?? 'BAD_REQUEST';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// The pg driver adapter reports the violated constraint under driverAdapterError instead of meta.target, and
// Postgres always names it, so the columns come from Prisma's default name: <Model>_<field>_<field>_key.
function uniqueFields(meta: Record<string, unknown> | undefined): string[] | undefined {
  const target = meta?.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === 'string') return [target];
  const driverError = meta?.driverAdapterError;
  const cause = isRecord(driverError) ? driverError.cause : undefined;
  const constraint = isRecord(cause) ? cause.constraint : undefined;
  if (!isRecord(constraint)) return undefined;
  if (Array.isArray(constraint.fields)) return constraint.fields.map(String);
  const model = meta?.modelName;
  const index = constraint.index;
  if (typeof index !== 'string' || typeof model !== 'string') return undefined;
  const prefix = `${model}_`;
  if (!index.startsWith(prefix) || !index.endsWith('_key')) return undefined;
  const fields = index.slice(prefix.length, -'_key'.length).split('_');
  return fields.every(Boolean) ? fields : undefined;
}

/** The columns of the unique constraint a P2002 violated, or undefined for any other error or an unnamed constraint. */
export function uniqueViolationFields(error: unknown): string[] | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return undefined;
  return uniqueFields(error.meta);
}

function classifyPrisma(error: Prisma.PrismaClientKnownRequestError): ClassifiedError {
  switch (error.code) {
    case 'P2002': {
      const fields = uniqueFields(error.meta)?.join(', ');
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

function httpExtensions(exception: HttpException): Record<string, unknown> | undefined {
  const response = exception.getResponse();
  const extensions = isRecord(response) ? response.extensions : undefined;
  return isRecord(extensions) ? extensions : undefined;
}

function httpMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join('; ');
  return typeof message === 'string' ? message : exception.message;
}

// Safe for logs: Prisma's own message can contain the values being written, so only its code and target are kept.
export function describeErrorForLog(exception: unknown): string {
  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    const fields = uniqueFields(exception.meta)?.join(',');
    const model = typeof exception.meta?.modelName === 'string' ? exception.meta.modelName : undefined;
    const where = [model, fields].filter(Boolean).join('.');
    return `Prisma ${exception.code}${where ? ` on ${where}` : ''}`;
  }
  if (exception instanceof Prisma.PrismaClientValidationError) return 'Prisma validation error';
  return exception instanceof Error ? exception.message : String(exception);
}

/** The one stack-trace policy for logs: stacks only in development (Sentry keeps them elsewhere). */
export function stackForLog(exception: unknown): string | undefined {
  return process.env.NODE_ENV === 'development' && exception instanceof Error ? exception.stack : undefined;
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
  const extensions = httpExtensions(exception);
  return {
    status,
    code: errorCodeForStatus(status),
    message: httpMessage(exception),
    ...(extensions && { extensions }),
  };
}
