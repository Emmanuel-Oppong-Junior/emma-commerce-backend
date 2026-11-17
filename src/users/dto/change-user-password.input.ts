import { Field, InputType } from '@nestjs/graphql';
import {
  IsPasswordAttempt,
  MeetsPasswordPolicy,
  PASSWORD_POLICY_DESCRIPTION,
} from '../../iam/authentication/password-policy';

@InputType()
export class ChangeUserPasswordInput {
  @Field(() => String, { description: `The new password to set: ${PASSWORD_POLICY_DESCRIPTION}` })
  @MeetsPasswordPolicy()
  newPassword: string;

  @Field(() => String, { description: 'The current password for verification' })
  @IsPasswordAttempt()
  oldPassword: string;
}
