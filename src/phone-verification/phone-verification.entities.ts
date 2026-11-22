import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';
import { Matches } from 'class-validator';

@ObjectType({ description: "Whether the account's current phone number is verified" })
export class PhoneVerificationStatusEntity {
  @Field({ description: 'True once a code sent to the current phone number was confirmed; false again after a change' })
  phoneVerified: boolean;

  @Field(() => Date, { nullable: true, description: 'When the current phone number was verified' })
  phoneVerifiedAt: Date | null;
}

@ObjectType({ description: 'A verification code was sent by SMS' })
export class PhoneVerificationRequest {
  @Field({ description: 'Last 3 digits of the number the code was sent to' })
  phoneLast3: string;

  @Field(() => Int, { description: 'Seconds the code stays valid' })
  expiresInSeconds: number;

  @Field(() => Int, { description: 'Seconds before another code can be requested' })
  resendAfterSeconds: number;
}

@InputType()
export class VerifyPhoneInput {
  @Field({ description: 'The 6-digit code from the SMS' })
  @Matches(/^\d{6}$/, { message: 'code must be the 6 digits from the SMS' })
  code: string;
}
