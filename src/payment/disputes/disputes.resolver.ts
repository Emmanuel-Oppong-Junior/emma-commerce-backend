import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { DisputeRecord } from './disputes.repository';
import { DisputesService } from './disputes.service';
import {
  AddDisputeNoteInput,
  DisputeEntity,
  DisputesArgs,
  RecordDisputeInput,
  UpdateDisputeStatusInput,
} from './disputes.entities';

function toEntity({ events, ...dispute }: DisputeRecord): DisputeEntity {
  return { ...dispute, history: events };
}

@Resolver(() => DisputeEntity)
export class DisputesResolver {
  constructor(private readonly disputesService: DisputesService) {}

  @RequirePermission('payment.view')
  @Query(() => [DisputeEntity], {
    description: 'Disputes and chargebacks, newest first, optionally by status or payment (staff)',
  })
  async disputes(@Args() args: DisputesArgs) {
    const found = await this.disputesService.findMany({
      status: args.status,
      attemptId: args.paymentId,
      take: args.first,
    });
    return found.map(toEntity);
  }

  @RequirePermission('payment.view')
  @Query(() => DisputeEntity, { description: 'One dispute with its notes and history (staff)' })
  async dispute(@Args('id', { type: () => ID }) id: string) {
    return toEntity(await this.disputesService.findOne(id));
  }

  @RequirePermission('payment.dispute.manage')
  @Mutation(() => DisputeEntity, {
    description:
      'Record a dispute against a captured online payment by hand (e.g. a chargeback notice by email). Owner, Manager, audited',
  })
  async recordDispute(@ActiveUser('id') actorId: string, @Args('input') input: RecordDisputeInput) {
    return toEntity(await this.disputesService.recordDispute(input, actorId));
  }

  @RequirePermission('payment.dispute.manage')
  @Mutation(() => DisputeEntity, {
    description:
      'Move a dispute to another status (OPEN -> AWAITING_EVIDENCE/UNDER_REVIEW -> WON/LOST/ACCEPTED); CONFLICT for a move the table does not allow. Owner, Manager, audited',
  })
  async updateDisputeStatus(@ActiveUser('id') actorId: string, @Args('input') input: UpdateDisputeStatusInput) {
    return toEntity(
      await this.disputesService.updateStatus(input.disputeId, input.status, input.note ?? null, actorId),
    );
  }

  @RequirePermission('payment.dispute.manage')
  @Mutation(() => DisputeEntity, { description: 'Append an evidence note to a dispute. Owner, Manager, audited' })
  async addDisputeNote(@ActiveUser('id') actorId: string, @Args('input') input: AddDisputeNoteInput) {
    return toEntity(await this.disputesService.addNote(input.disputeId, input.body, actorId));
  }
}
