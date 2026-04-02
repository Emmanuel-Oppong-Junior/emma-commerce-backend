import { Field, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsString } from 'class-validator';

@InputType()
export class SignOutInput {
  @Field({ description: 'The refresh token to revoke' })
  @IsNotEmpty()
  @IsString()
  refreshToken: string;
}
