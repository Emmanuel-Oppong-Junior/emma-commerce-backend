import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SignUpInput } from './dto/sign-up.input';
import { SignInInput } from './dto/sign-in.input';
import { ResetPasswordInput } from './dto/reset-password.input';
import { ChangeUserPasswordInput } from '../../users/dto/change-user-password.input';
import { CreateUserInput } from '../../users/dto/create-user.input';
import { Role } from '../../users/enums/role.enum';

async function passwordErrors<T extends object>(cls: new () => T, input: object, field: string): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, input));
  return errors.filter((e) => e.property === field).flatMap((e) => Object.values(e.constraints ?? {}));
}

const signUp = (password: string) =>
  passwordErrors(SignUpInput, { name: 'Ama', email: 'ama@test.local', password }, 'password');
const signIn = (password: string) => passwordErrors(SignInInput, { email: 'ama@test.local', password }, 'password');
const reset = (newPassword: string) =>
  passwordErrors(ResetPasswordInput, { resetToken: 't', newPassword }, 'newPassword');
const changeTo = (newPassword: string) =>
  passwordErrors(ChangeUserPasswordInput, { oldPassword: 'Old-pass1', newPassword }, 'newPassword');
const changeFrom = (oldPassword: string) =>
  passwordErrors(ChangeUserPasswordInput, { oldPassword, newPassword: 'New-pass1' }, 'oldPassword');
const createUser = (password: string) =>
  passwordErrors(
    CreateUserInput,
    { name: 'Ama', email: 'ama@test.local', password, isActive: true, role: Role.USER },
    'password',
  );

const choosers = { signUp, reset, changeTo, createUser };

describe('password policy', () => {
  const valid = ['Abcdef1!', 'Abcdefgh1!Abcdefgh1!', 'Aa1#' + 'x'.repeat(124)];
  const invalid = {
    tooShort: 'Abcde1!',
    tooLong: 'Aa1#' + 'x'.repeat(125),
    noComplexity: 'aaaaaaaa',
    noSpecial: 'Abcdefgh1',
    disallowedCharacter: 'Abcdef1! ',
  };

  describe.each(Object.entries(choosers))('%s', (_name, check) => {
    it.each(valid)('accepts policy-compliant password #%#', async (password) => {
      expect(await check(password)).toEqual([]);
    });

    it.each(Object.entries(invalid))('rejects %s', async (_case, password) => {
      expect(await check(password)).not.toEqual([]);
    });
  });

  it.each(valid)('sign-in and current-password checks accept every password sign-up accepts (%#)', async (password) => {
    expect(await signUp(password)).toEqual([]);
    expect(await signIn(password)).toEqual([]);
    expect(await changeFrom(password)).toEqual([]);
  });

  it('sign-in checks only bounds, so it does not reveal the complexity rule', async () => {
    expect(await signIn('aaaaaaaa')).toEqual([]);
    expect(await signIn('')).not.toEqual([]);
    expect(await signIn(invalid.tooLong)).toEqual(['Password must be at most 128 characters.']);
  });
});
