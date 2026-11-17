import { Field, InputType } from '@nestjs/graphql';
import { IsEmail } from 'class-validator';
import { Transform } from 'class-transformer';

@InputType()
export class ForgotPasswordInput {
  @Field()
  @IsEmail()
  @Transform(({ value }) => value?.trim().toLowerCase())
  email: string;
}
