import { GraphQLError } from 'graphql';
import { formatError } from './grapqhl-error.formatter';
import { LoggerService } from '../logger.service';
import { reportError } from '../../observability/error-reporting';

jest.mock('../../observability/error-reporting', () => ({ reportError: jest.fn() }));

describe('formatError', () => {
  const logger = { error: jest.fn() };
  const format = formatError(logger as unknown as LoggerService);

  it('returns the MFA challenge to the client but keeps it out of the log', () => {
    const formatted = {
      message: 'Two-factor authentication required',
      extensions: { code: 'UNAUTHENTICATED', reason: 'MFA_REQUIRED', mfaChallenge: 'challenge.jwt.value' },
    };

    expect(format(formatted, new Error('x'))).toBe(formatted);
    const [logged] = logger.error.mock.calls[0];
    expect(logged).toContain('MFA_REQUIRED');
    expect(logged).not.toContain('challenge.jwt.value');
  });

  // Apollo answers variables that do not coerce itself, without a status: a client error, never reported.
  it('does not report a variable coercion error', () => {
    const formatted = {
      message: 'Variable "$first" of required type "Int!" was not provided.',
      extensions: { code: 'BAD_USER_INPUT' },
    };

    expect(format(formatted, new GraphQLError(formatted.message))).toBe(formatted);
    expect(reportError).not.toHaveBeenCalled();
  });

  describe('in production', () => {
    const nodeEnv = process.env.NODE_ENV;
    beforeEach(() => (process.env.NODE_ENV = 'production'));
    afterEach(() => (process.env.NODE_ENV = nodeEnv));

    it('masks an internal error', () => {
      const formatted = { message: 'relation "Order" does not exist', extensions: { code: 'INTERNAL_SERVER_ERROR' } };

      expect(format(formatted, new Error('x'))).toEqual({
        message: 'Internal server error',
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      });
    });

    it('keeps the message and reason of a service the store cannot use right now', () => {
      const formatted = {
        message: 'Image upload is unavailable, try again later',
        extensions: { code: 'SERVICE_UNAVAILABLE', reason: 'IMAGE_STORAGE_UNAVAILABLE', status: 503 },
      };

      expect(format(formatted, new Error('x'))).toBe(formatted);
    });
  });
});
