import { LoggerService } from '../logger.service';
import { GraphQLError, GraphQLFormattedError } from 'graphql';
import { stackForLog } from '../filters/error-classification';
import { reportError } from '../../observability/error-reporting';

const INTERNAL_ERROR_CODE = 'INTERNAL_SERVER_ERROR';
// Extensions returned to the client but kept out of logs: the MFA challenge is half of a sign-in.
const UNLOGGED_EXTENSIONS = ['mfaChallenge'];

function loggableExtensions(extensions: GraphQLFormattedError['extensions']) {
  if (!extensions) return extensions;
  return Object.fromEntries(
    Object.entries(extensions).map(([key, value]) => [key, UNLOGGED_EXTENSIONS.includes(key) ? '[redacted]' : value]),
  );
}

const isSafeToExpose = (extensions: GraphQLFormattedError['extensions']): boolean => {
  const code = extensions?.code as string | undefined;
  // Expose validation, auth, and business logic errors to clients
  const safeCode = [
    'BAD_USER_INPUT',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'CONFLICT',
    'BAD_REQUEST',
    'GRAPHQL_VALIDATION_FAILED',
    'GRAPHQL_PARSE_FAILED',
    'SERVICE_UNAVAILABLE',
  ];
  return !!code && safeCode.includes(code);
};

export const formatError =
  (logger: LoggerService) =>
  (formattedError: GraphQLFormattedError, error: unknown): GraphQLFormattedError => {
    const { message, locations, path, extensions } = formattedError;
    const stack = error instanceof GraphQLError ? stackForLog(error) : undefined;
    logger.error(
      `GraphQL Error: ${message} | Path: ${path?.join(' > ')} | Locations: ${JSON.stringify(locations)} | Extensions: ${JSON.stringify(loggableExtensions(extensions))}`,
      stack,
      'GraphQL',
    );

    // Errors from resolvers were classified (and reported) by AllExceptionsFilter, which sets `status`. Anything else
    // that is not a client error (a field resolver failure, an Apollo internal error) is reported here.
    if (!isSafeToExpose(extensions) && extensions?.status === undefined) {
      reportError(error instanceof GraphQLError && error.originalError ? error.originalError : error);
    }

    // In production, mask internal errors so DB details never reach the client
    if (process.env.NODE_ENV === 'production' && !isSafeToExpose(extensions)) {
      return { message: 'Internal server error', extensions: { code: INTERNAL_ERROR_CODE } };
    }

    return formattedError;
  };
