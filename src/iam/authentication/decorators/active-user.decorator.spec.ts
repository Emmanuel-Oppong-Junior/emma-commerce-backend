import { activeUserFactory } from './active-user.decorator';
import { graphqlContext, httpContext } from '../../../../test/helpers/execution-context.helper';

describe('ActiveUser', () => {
  const user = { id: 'user-1', role: 'USER' };

  describe.each([
    ['http', httpContext],
    ['graphql', graphqlContext],
  ])('%s request', (_type, buildContext) => {
    it('returns the authenticated user', () => {
      expect(activeUserFactory(undefined, buildContext({ user }))).toBe(user);
    });

    it('returns a single field of the user', () => {
      expect(activeUserFactory('id', buildContext({ user }))).toBe('user-1');
    });

    it('returns undefined for an anonymous request', () => {
      expect(activeUserFactory('id', buildContext({}))).toBeUndefined();
    });
  });
});
