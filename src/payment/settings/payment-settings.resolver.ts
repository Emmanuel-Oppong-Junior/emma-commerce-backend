import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../../iam/authentication/enums/auth-type.enum';
import { RequirePermission, RequireStepUp } from '../../iam/authorization/policy.decorators';
import { PaymentSettingsService } from './payment-settings.service';
import {
  AvailablePaymentMethods,
  PaymentSettings,
  SetPaystackConfigInput,
  UpdatePaymentMethodsInput,
} from './payment-settings.entities';

@Resolver(() => PaymentSettings)
export class PaymentSettingsResolver {
  constructor(private readonly settings: PaymentSettingsService) {}

  @RequirePermission('payment.settings.manage')
  @Query(() => PaymentSettings, {
    name: 'paymentSettings',
    description: 'The payment methods and the Paystack config in use, without the secret key (Owner)',
  })
  getPaymentSettings() {
    return this.settings.getSettings();
  }

  @RequirePermission('payment.settings.manage')
  @RequireStepUp()
  @Mutation(() => PaymentSettings, {
    description:
      'Store the Paystack keys for this store, encrypted, replacing any earlier ones; they take precedence over PAYSTACK_SECRET_KEY and sign-check webhooks from then on. Owner, recent step-up, audited without the secret',
  })
  setPaystackConfig(@ActiveUser('id') actorId: string, @Args('input') input: SetPaystackConfigInput) {
    return this.settings.setPaystackConfig(input, actorId);
  }

  @RequirePermission('payment.settings.manage')
  @RequireStepUp()
  @Mutation(() => PaymentSettings, {
    description:
      'Delete the stored Paystack keys, so PAYSTACK_SECRET_KEY (if set) applies again. NOT_FOUND when none are stored. Owner, recent step-up, audited',
  })
  removePaystackConfig(@ActiveUser('id') actorId: string) {
    return this.settings.removePaystackConfig(actorId);
  }

  @RequirePermission('payment.settings.manage')
  @RequireStepUp()
  @Mutation(() => PaymentSettings, {
    description:
      'Switch card, mobile money and cash on delivery on or off and choose the provider of each online method. Owner, recent step-up, audited',
  })
  updatePaymentMethods(@ActiveUser('id') actorId: string, @Args('input') input: UpdatePaymentMethodsInput) {
    return this.settings.updatePaymentMethods(input, actorId);
  }

  @Auth(AuthType.None)
  @Query(() => AvailablePaymentMethods, {
    description:
      'What a customer can pay with right now: the online methods on offer and whether cash on delivery is (public)',
  })
  availablePaymentMethods() {
    return this.settings.publicPaymentMethods();
  }
}
