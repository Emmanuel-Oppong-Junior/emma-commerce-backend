import { applyDecorators } from '@nestjs/common';
import { IsNotEmpty, IsString, Length, Matches, MaxLength } from 'class-validator';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const PASSWORD_SPECIAL_CHARACTERS = '@$!%*?&_-#';
const PASSWORD_COMPLEXITY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&_\-#])[A-Za-z\d@$!%*?&_\-#]+$/;

export const PASSWORD_POLICY_DESCRIPTION = `${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters, with at least one uppercase letter, one lowercase letter, one number and one special character (${PASSWORD_SPECIAL_CHARACTERS}); no other characters`;

export function MeetsPasswordPolicy(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, {
      message: `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`,
    }),
    Matches(PASSWORD_COMPLEXITY, {
      message: `Password must contain at least one uppercase letter, one lowercase letter, one number and one special character (${PASSWORD_SPECIAL_CHARACTERS}), and no other characters.`,
    }),
  );
}

// Checked against a stored hash, so only bounds: login must not reveal the policy and must accept any
// password the policy (or an older one) accepted.
export function IsPasswordAttempt(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    IsNotEmpty({ message: 'Password is required.' }),
    MaxLength(PASSWORD_MAX_LENGTH, { message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.` }),
  );
}
