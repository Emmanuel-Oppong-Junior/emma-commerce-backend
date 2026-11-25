import { Field, InputType } from '@nestjs/graphql';
import { IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';
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

  @Field(() => String, {
    nullable: true,
    description:
      'A guest order access token (createGuestOrder.orderAccessToken, P6-G.1): the phone the guest verified becomes ' +
      "the account's verified phone and the guest orders placed with it move to the account. BAD_REQUEST with reason " +
      'INVALID_GUEST_ORDER_TOKEN or GUEST_VERIFICATION_EXPIRED (verified over 30 days ago), CONFLICT with reason ' +
      'PHONE_IN_USE (another account holds the number)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  guestOrderToken?: string;
}
