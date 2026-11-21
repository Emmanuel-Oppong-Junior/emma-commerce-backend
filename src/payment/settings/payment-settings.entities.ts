import { Field, GraphQLISODateTime, ID, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUrl, Matches, MaxLength, ValidateIf } from 'class-validator';
import { OnlinePaymentMethod } from './payment-methods';

registerEnumType(OnlinePaymentMethod, {
  name: 'OnlinePaymentMethod',
  description: 'How an ONLINE order is paid; chosen per payment attempt',
});

/** Providers that can serve an online payment method; Flutterwave joins in P3-D. Values match the Prisma enum. */
export enum OnlinePaymentProvider {
  PAYSTACK = 'PAYSTACK',
}

registerEnumType(OnlinePaymentProvider, { name: 'OnlinePaymentProvider' });

export enum PaymentProviderModeEnum {
  TEST = 'TEST',
  LIVE = 'LIVE',
}

registerEnumType(PaymentProviderModeEnum, {
  name: 'PaymentProviderMode',
  description: 'Test or live keys, from the secret key prefix',
});

export enum PaymentCredentialSource {
  DATABASE = 'DATABASE',
  ENVIRONMENT = 'ENVIRONMENT',
  NONE = 'NONE',
}

registerEnumType(PaymentCredentialSource, {
  name: 'PaymentCredentialSource',
  description:
    'Where the credentials in use come from: the store config (setPaystackConfig), the server environment fallback, or nowhere (online payment unavailable)',
});

@ObjectType({
  description: 'The Paystack config in use. The secret key is write-only: only its last 4 characters show',
})
export class PaystackSettings {
  @Field()
  configured: boolean;

  @Field(() => PaymentCredentialSource)
  source: PaymentCredentialSource;

  @Field(() => PaymentProviderModeEnum, {
    nullable: true,
    description: 'Null for an environment key without sk_test_/sk_live_',
  })
  mode: PaymentProviderModeEnum | null;

  @Field(() => String, { nullable: true })
  secretKeyLast4: string | null;

  @Field(() => String, { nullable: true })
  publicKey: string | null;

  @Field(() => String, { nullable: true, description: 'Where Paystack sends the customer after paying' })
  callbackUrl: string | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Null unless the config is stored in the database' })
  updatedAt: Date | null;

  @Field(() => ID, { nullable: true, description: 'The staff user who last set the config' })
  updatedById: string | null;
}

@ObjectType({ description: 'Which payment methods the store offers and which provider serves each online method' })
export class PaymentMethodSettings {
  @Field()
  cardPaymentsEnabled: boolean;

  @Field()
  mobileMoneyPaymentsEnabled: boolean;

  @Field()
  cashOnDeliveryEnabled: boolean;

  @Field(() => OnlinePaymentProvider)
  cardPaymentProvider: OnlinePaymentProvider;

  @Field(() => OnlinePaymentProvider)
  mobileMoneyPaymentProvider: OnlinePaymentProvider;
}

@ObjectType({ description: 'The store payment settings (payment.settings.manage)' })
export class PaymentSettings {
  @Field(() => PaymentMethodSettings)
  methods: PaymentMethodSettings;

  @Field(() => PaystackSettings)
  paystack: PaystackSettings;
}

@ObjectType()
export class AvailableOnlinePaymentMethod {
  @Field(() => OnlinePaymentMethod)
  method: OnlinePaymentMethod;

  @Field(() => OnlinePaymentProvider)
  provider: OnlinePaymentProvider;

  @Field(() => String, { nullable: true, description: "The provider's public key, for opening its popup checkout" })
  publicKey: string | null;
}

@ObjectType({ description: 'What a customer can pay with at this store right now' })
export class AvailablePaymentMethods {
  @Field(() => [AvailableOnlinePaymentMethod], {
    description:
      'Online methods on offer (ONLINE orders need at least one); pass the method to POST /payment/initialize',
  })
  online: AvailableOnlinePaymentMethod[];

  @Field({ description: 'Whether CASH_ON_DELIVERY orders are accepted' })
  cashOnDelivery: boolean;
}

@InputType({ description: 'The whole Paystack config; it replaces the current one' })
export class SetPaystackConfigInput {
  @Field({ description: 'Secret key (sk_test_... or sk_live_...); the mode follows its prefix. Write-only' })
  @IsString()
  @Matches(/^sk_(test|live)_[A-Za-z0-9]+$/, { message: 'secretKey must start with sk_test_ or sk_live_' })
  @MaxLength(200)
  secretKey: string;

  @Field(() => String, { nullable: true, description: 'Public key (pk_test_... or pk_live_...) of the same mode' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  publicKey?: string | null;

  @Field(() => String, { nullable: true, description: 'Overrides PAYSTACK_CALLBACK_URL when set' })
  @IsOptional()
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true, require_tld: false })
  @MaxLength(2000)
  callbackUrl?: string | null;
}

// Omitted means unchanged; null is validated (and rejected) because these columns cannot be cleared.
const unlessOmitted = ValidateIf((_: object, value: unknown) => value !== undefined);

@InputType({ description: 'Payment-method switches to change; omitted fields keep their value' })
export class UpdatePaymentMethodsInput {
  @Field(() => Boolean, { nullable: true })
  @unlessOmitted
  @IsBoolean()
  cardPaymentsEnabled?: boolean;

  @Field(() => Boolean, { nullable: true })
  @unlessOmitted
  @IsBoolean()
  mobileMoneyPaymentsEnabled?: boolean;

  @Field(() => Boolean, { nullable: true })
  @unlessOmitted
  @IsBoolean()
  cashOnDeliveryEnabled?: boolean;

  @Field(() => OnlinePaymentProvider, { nullable: true })
  @unlessOmitted
  @IsEnum(OnlinePaymentProvider)
  cardPaymentProvider?: OnlinePaymentProvider;

  @Field(() => OnlinePaymentProvider, { nullable: true })
  @unlessOmitted
  @IsEnum(OnlinePaymentProvider)
  mobileMoneyPaymentProvider?: OnlinePaymentProvider;
}
