import { Field, GraphQLISODateTime, InputType, ObjectType } from '@nestjs/graphql';
import { IsJWT, IsString, Length } from 'class-validator';

@ObjectType({ description: 'A started two-factor enrolment; confirm it with a code from the authenticator app' })
export class MfaEnrollment {
  @Field({ description: 'The TOTP secret in base32, for typing into an app that cannot scan the QR code' })
  secret: string;

  @Field({ description: 'otpauth:// URI to show as a QR code (SHA1, 6 digits, 30 seconds)' })
  otpauthUri: string;
}

@ObjectType({ description: 'Single-use recovery codes, returned only once' })
export class MfaRecoveryCodes {
  @Field(() => [String], { description: 'Each code works once in place of an authenticator code' })
  recoveryCodes: string[];
}

@ObjectType({ description: 'A successful step-up verification' })
export class StepUpResult {
  @Field(() => GraphQLISODateTime, { description: 'Sensitive actions are allowed in this session until then' })
  validUntil: Date;
}

@InputType()
export class CompleteMfaSignInInput {
  @Field({ description: 'extensions.mfaChallenge from the MFA_REQUIRED signIn error (valid 5 minutes)' })
  @IsJWT()
  challenge: string;

  @Field({ description: 'A 6-digit authenticator code or an unused recovery code' })
  @IsString()
  @Length(6, 32)
  code: string;
}
