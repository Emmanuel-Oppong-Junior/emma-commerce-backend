import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { discrepancyKind } from './cash-remittance';
import { RemittanceRecord } from './cash.repository';
import { CashService } from './cash.service';
import {
  CashCollectionEntity,
  CashRemittanceEntity,
  CashRemittancesArgs,
  CodCashReport,
  CodCashReportInput,
  RecordCashRemittanceInput,
} from './cash.entities';

function toEntity(remittance: RemittanceRecord): CashRemittanceEntity {
  return {
    ...remittance,
    discrepancy: remittance.discrepancy.toFixed(2),
    discrepancyKind: discrepancyKind(remittance.discrepancy),
  };
}

@Resolver(() => CashRemittanceEntity)
export class CashResolver {
  constructor(private readonly cashService: CashService) {}

  @RequirePermission('cod.cash.manage')
  @Query(() => [CashCollectionEntity], {
    description: "A rider's cash collections not handed in yet, oldest first (staff: Owner, Manager, Cashier)",
  })
  unremittedCashCollections(@Args('riderId', { type: () => ID }) riderId: string) {
    return this.cashService.findUnremittedCollections(riderId);
  }

  @RequirePermission('cod.cash.manage')
  @Query(() => [CashRemittanceEntity], { description: 'Cash remittances, newest first, optionally of one rider' })
  async cashRemittances(@Args() args: CashRemittancesArgs) {
    return (await this.cashService.findRemittances(args.riderId, args.first)).map(toEntity);
  }

  @RequirePermission('cod.cash.manage')
  @Mutation(() => CashRemittanceEntity, {
    description:
      "Record cash a rider handed in, covering some of the rider's unremitted collections. A short or over amount needs a note (BAD_REQUEST reason DISCREPANCY_NOTE_REQUIRED); a collection already remitted gives CONFLICT (COLLECTION_ALREADY_REMITTED). Immutable once recorded; audited",
  })
  async recordCashRemittance(@ActiveUser('id') actorId: string, @Args('input') input: RecordCashRemittanceInput) {
    return toEntity(await this.cashService.recordRemittance(input, actorId));
  }

  @RequirePermission('cod.cash.manage')
  @Query(() => CodCashReport, {
    description:
      'Cash-on-delivery cash per rider for [from, to): collected, outstanding, remitted, short/over; and COD orders delivered with no cash recorded',
  })
  codCashReport(@Args('input') input: CodCashReportInput) {
    return this.cashService.report(input);
  }
}
