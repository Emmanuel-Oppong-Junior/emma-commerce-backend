import { Field, InputType } from '@nestjs/graphql';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, IsUrl, Length } from 'class-validator';
import { Role } from '../enums/role.enum';
import { Transform } from 'class-transformer';
import { MeetsPasswordPolicy, PASSWORD_POLICY_DESCRIPTION } from '../../iam/authentication/password-policy';

@InputType()
export class CreateUserInput {
  @Transform(({ value }) => value?.trim().toLowerCase())
  @Field(() => String, { description: 'User’s name' })
  @IsString()
  @Length(2, 50, { message: 'Name must be between 2 and 50 characters.' })
  name: string;

  @Field(() => String, { description: 'Email address' })
  @IsEmail({}, { message: 'Please enter a valid email address.' })
  @Transform(({ value }) => value?.trim().toLowerCase())
  email: string;

  @Field(() => String, { description: `Password (required for manual signup): ${PASSWORD_POLICY_DESCRIPTION}` })
  @IsOptional()
  @MeetsPasswordPolicy()
  password?: string;

  @Field(() => String, { nullable: true, description: 'Phone number' })
  @IsOptional()
  phoneNumber?: string;

  @Field(() => Boolean, {
    defaultValue: true,
    description: 'Whether the account is active',
  })
  @IsBoolean()
  isActive: boolean;

  @Field(() => String, { nullable: true, description: 'Profile picture URL' })
  @IsOptional()
  @IsString()
  @IsUrl()
  profilePicture?: string;

  @Field(() => Role, { description: 'Role name', defaultValue: 'USER' })
  @IsEnum(Role)
  @IsString()
  role: Role;
}
