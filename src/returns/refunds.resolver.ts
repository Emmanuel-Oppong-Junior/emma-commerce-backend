import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { RefundStatus } from '../generated/prisma/client';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RefundEntity } from './entities/refund.entity';
import { RefundStatusEnum } from './enums/refund-status.enum';
import { RefundsService } from './refunds.service';
import { RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';

@Resolver(() => RefundEntity)
export class RefundsResolver {
  constructor(private readonly refundsService: RefundsService) {}

  @RequirePermission('payment.view')
  @Query(() => [RefundEntity], { description: 'List refunds, optionally by status, newest first (admin only)' })
  refunds(@Args('status', { type: () => RefundStatusEnum, nullable: true }) status?: RefundStatus) {
    return this.refundsService.findAll(status);
  }

  @RequirePermission('order.refund')
  @RequireStepUp()
  @Mutation(() => RefundEntity, {
    description: 'Send a PENDING refund (e.g. an auto-refund of a flagged payment) or resend a FAILED one (admin only)',
  })
  processPendingRefund(@ActiveUser('id') adminUserId: string, @Args('refundId', { type: () => ID }) refundId: string) {
    return this.refundsService.processPendingRefund(refundId, adminUserId);
  }
}
