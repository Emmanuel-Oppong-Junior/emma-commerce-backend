import { Field, InputType } from '@nestjs/graphql';
import { IsEmail, IsNotEmpty, IsString, Length, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

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

  @Field(() => String, {
    description: 'Password - min 8 chars, must include uppercase, lowercase, number, and special character',
  })
  @IsNotEmpty()
  @IsString()
  @Length(8, 64, { message: 'Password must be between 8 and 64 characters.' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&_\-#])[A-Za-z\d@$!%*?&_\-#]{8,}$/, {
    message: 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&_-#).',
  })
  password: string;
}
