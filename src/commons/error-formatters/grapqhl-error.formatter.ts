import { LoggerService } from '../logger.service';
import { GraphQLError } from 'graphql/error';

const INTERNAL_ERROR_CODE = 'INTERNAL_SERVER_ERROR';

const isSafeToExpose = (error: GraphQLError): boolean => {
  const code = error.extensions?.code as string | undefined;
  // Expose validation, auth, and business logic errors to clients
  const safeCode = ['BAD_USER_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'BAD_REQUEST'];
  return !!code && safeCode.includes(code);
};

export const formatError = (logger: LoggerService) => (error: GraphQLError) => {
  const { message, locations, path, extensions } = error;
  logger.error(
    `GraphQL Error: ${message} | Path: ${path?.join(' > ')} | Locations: ${JSON.stringify(locations)} | Extensions: ${JSON.stringify(extensions)}`,
    error.stack,
    'GraphQL',
  );

  // In production, mask internal errors so DB details never reach the client
  if (process.env.NODE_ENV === 'production' && !isSafeToExpose(error)) {
    return new GraphQLError('Internal server error', {
      extensions: { code: INTERNAL_ERROR_CODE },
    });
  }

  return error;
};
