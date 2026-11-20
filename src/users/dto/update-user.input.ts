import { Field, InputType } from '@nestjs/graphql';
import { IsEmail, IsOptional, IsString, IsUrl, Length } from 'class-validator';
import { Transform } from 'class-transformer';
import { GHANA_PHONE_FORMATS_DESCRIPTION, IsGhanaPhone } from '../../commons/phone/ghana-phone';

@InputType()
export class UpdateUserInput {
  @Field(() => String, { description: 'User’s name', nullable: true })
  @Transform(({ value }) => (value ? value.trim().toLowerCase() : value))
  @IsString()
  @IsOptional()
  @Length(2, 50, { message: 'Name must be between 2 and 50 characters.' })
  name?: string;

  @Field(() => String, { description: 'Email address', nullable: true })
  @IsEmail({}, { message: 'Please enter a valid email address.' })
  @Transform(({ value }) => (value ? value.trim().toLowerCase() : value))
  @IsOptional()
  email?: string;

  @Field(() => String, {
    nullable: true,
    description: `Phone number: ${GHANA_PHONE_FORMATS_DESCRIPTION}. Send null to remove it.`,
  })
  @IsOptional()
  @IsGhanaPhone()
  phoneNumber?: string | null;

  @Field(() => String, { nullable: true, description: 'Profile picture URL' })
  @IsOptional()
  @IsString()
  @IsUrl()
  profilePicture?: string;
}
