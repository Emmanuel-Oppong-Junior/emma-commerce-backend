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
});
