import { Field, InputType } from '@nestjs/graphql';
import { IsEmail } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsPasswordAttempt } from '../password-policy';

@InputType()
export class SignInInput {
  @Field(() => String, { description: 'Email address' })
  @IsEmail({}, { message: 'Please enter a valid email address.' })
  @Transform(({ value }) => value?.trim().toLowerCase())
  email: string;

  @Field(() => String, { description: 'Password' })
  @IsPasswordAttempt()
  password: string;
}
