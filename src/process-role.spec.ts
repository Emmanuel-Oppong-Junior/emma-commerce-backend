import { selectProcessRole } from './process-role';

describe('selectProcessRole', () => {
  it('starts the API when neither ROLE nor --role is given', () => {
    expect(selectProcessRole(undefined, ['node', 'dist/main'])).toBe('api');
  });

  it.each(['api', 'worker'] as const)('starts the %s role from ROLE', (role) => {
    expect(selectProcessRole(role, [])).toBe(role);
  });

  it('lets --role override ROLE', () => {
    expect(selectProcessRole('api', ['node', 'dist/main', '--role=worker'])).toBe('worker');
  });

  it.each([
    ['ROLE', 'wrker', []],
    ['--role', undefined, ['--role=scheduler']],
    ['an empty ROLE', '', []],
  ])('rejects an unknown role from %s', (_source, variable, args) => {
    expect(() => selectProcessRole(variable, args)).toThrow(/Unknown process role .*api, worker/);
  });
});
