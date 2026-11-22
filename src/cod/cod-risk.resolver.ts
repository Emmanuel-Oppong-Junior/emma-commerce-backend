import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';
import { ShippingZoneEntity } from '../shipping-zones/entities/shipping-zone.entity';
import { CodRiskService } from './cod-risk.service';
import {
  AddCodBlacklistEntryInput,
  CodBlacklistArgs,
  CodBlacklistEntryEntity,
  CodRiskSettingsEntity,
  UpdateCodRiskSettingsInput,
} from './cod-risk.entities';

@Resolver()
export class CodRiskResolver {
  constructor(private readonly codRisk: CodRiskService) {}

  @RequirePermission('payment.settings.manage')
  @Query(() => CodRiskSettingsEntity, {
    description: 'The cash-on-delivery limits: open orders per verified phone and the grand total cap (Owner)',
  })
  codRiskSettings() {
    return this.codRisk.getSettings();
  }

  @RequirePermission('payment.settings.manage')
  @RequireStepUp()
  @Mutation(() => CodRiskSettingsEntity, {
    description: 'Change the cash-on-delivery limits; fields left out keep their value. Owner, recent step-up, audited',
  })
  updateCodRiskSettings(@ActiveUser('id') actorId: string, @Args('input') input: UpdateCodRiskSettingsInput) {
    return this.codRisk.updateSettings(input, actorId);
  }

  @RequirePermission('payment.settings.manage')
  @RequireStepUp()
  @Mutation(() => ShippingZoneEntity, {
    description:
      'Allow or refuse cash on delivery for deliveries to a shipping zone (pickup is not affected). Owner, recent step-up, audited',
  })
  setShippingZoneCashOnDelivery(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('enabled') enabled: boolean,
  ) {
    return this.codRisk.setZoneCod(id, enabled, actorId);
  }

  @RequirePermission('payment.settings.manage')
  @Query(() => [CodBlacklistEntryEntity], {
    description: 'Phone numbers and delivery addresses refused cash on delivery, newest first (Owner)',
  })
  codBlacklist(@Args() args: CodBlacklistArgs) {
    return this.codRisk.blacklist(args.first);
  }

  @RequirePermission('payment.settings.manage')
  @RequireStepUp()
  @Mutation(() => CodBlacklistEntryEntity, {
    description:
      'Refuse cash on delivery to a phone number, GhanaPost GPS code or street in a city, stored normalised. ' +
      'CONFLICT when it is listed already. Owner, recent step-up, audited',
  })
  addCodBlacklistEntry(@ActiveUser('id') actorId: string, @Args('input') input: AddCodBlacklistEntryInput) {
    const { reason, ...target } = input;
    return this.codRisk.addToBlacklist(target, reason, actorId);
  }

  @RequirePermission('payment.settings.manage')
  @RequireStepUp()
  @Mutation(() => CodBlacklistEntryEntity, {
    description: 'Take an entry off the cash-on-delivery blacklist, returning it. Owner, recent step-up, audited',
  })
  removeCodBlacklistEntry(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.codRisk.removeFromBlacklist(id, actorId);
  }
}
