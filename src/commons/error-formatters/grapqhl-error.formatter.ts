import { LoggerService } from '../logger.service';
import { GraphQLError, GraphQLFormattedError } from 'graphql';

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
  ];
  return !!code && safeCode.includes(code);
};

export const formatError =
  (logger: LoggerService) =>
  (formattedError: GraphQLFormattedError, error: unknown): GraphQLFormattedError => {
    const { message, locations, path, extensions } = formattedError;
    const stack = error instanceof GraphQLError ? error.stack : undefined;
    logger.error(
      `GraphQL Error: ${message} | Path: ${path?.join(' > ')} | Locations: ${JSON.stringify(locations)} | Extensions: ${JSON.stringify(loggableExtensions(extensions))}`,
      stack,
      'GraphQL',
    );

    // In production, mask internal errors so DB details never reach the client
    if (process.env.NODE_ENV === 'production' && !isSafeToExpose(extensions)) {
      return { message: 'Internal server error', extensions: { code: INTERNAL_ERROR_CODE } };
    }

    return formattedError;
  };
