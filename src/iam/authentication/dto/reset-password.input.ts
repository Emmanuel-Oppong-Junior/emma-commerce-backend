import { Field, InputType } from '@nestjs/graphql';
import { IsString, MinLength } from 'class-validator';

@InputType()
export class ResetPasswordInput {
  @Field()
  @IsString()
  resetToken: string;

  @Field()
  @IsString()
  @MinLength(8)
  newPassword: string;
}
