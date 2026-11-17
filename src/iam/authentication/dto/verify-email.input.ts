import { Field, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

@InputType()
export class VerifyEmailInput {
  @Field({ description: 'The verification token from the email' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  token: string;
}
