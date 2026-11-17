import { Field, InputType } from '@nestjs/graphql';
import { IsString } from 'class-validator';
import { MeetsPasswordPolicy, PASSWORD_POLICY_DESCRIPTION } from '../password-policy';

@InputType()
export class ResetPasswordInput {
  @Field()
  @IsString()
  resetToken: string;

  @Field({ description: `New password: ${PASSWORD_POLICY_DESCRIPTION}` })
  @MeetsPasswordPolicy()
  newPassword: string;
}
