import { formatError } from './grapqhl-error.formatter';
import { LoggerService } from '../logger.service';

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
});
