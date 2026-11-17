import { Field, InputType } from '@nestjs/graphql';
import { IsEmail, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';
import { MeetsPasswordPolicy, PASSWORD_POLICY_DESCRIPTION } from '../password-policy';

@InputType()
export class SignUpInput {
  @Transform(({ value }) => value?.trim().toLowerCase())
  @Field(() => String, { description: "User's name" })
  @IsString()
  @Length(2, 50, { message: 'Name must be between 2 and 50 characters.' })
  name: string;

  @Field(() => String, { description: 'Email address' })
  @IsEmail({}, { message: 'Please enter a valid email address.' })
  @Transform(({ value }) => value?.trim().toLowerCase())
  email: string;

  @Field(() => String, { description: `Password: ${PASSWORD_POLICY_DESCRIPTION}` })
  @MeetsPasswordPolicy()
  password: string;
}
