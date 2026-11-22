import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { RefundStatus } from '../generated/prisma/client';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RefundEntity, RefundLineEntity } from './entities/refund.entity';
import { RefundStatusEnum } from './enums/refund-status.enum';
import { RefundsService } from './refunds.service';
import { RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';
import { RefundOrderInput } from './dto/refund-order.input';

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

  @RequirePermission('order.refund')
  @RequireStepUp()
  @Mutation(() => RefundEntity, {
    description:
      'Refund a paid order outside the returns flow: line units, the delivery fee and/or a free amount, with a ' +
      'reason. Money only (nothing is restocked). Online payments are refunded through Paystack at once; ' +
      'cash-on-delivery payments are recorded as cash handed back. CONFLICT when it would refund more than is left ' +
      '(units of a line, the delivery fee twice, or above what the payment captured). Admin only',
  })
  refundOrder(@ActiveUser('id') adminUserId: string, @Args('input') input: RefundOrderInput) {
    return this.refundsService.refundOrder(
      {
        orderId: input.orderId,
        idempotencyKey: input.idempotencyKey,
        lines: input.lines ?? [],
        shipping: input.shipping ?? false,
        amount: input.amount ?? null,
        reason: input.reason,
        note: input.note,
      },
      adminUserId,
    );
  }

  @ResolveField(() => [RefundLineEntity])
  lines(@Parent() refund: RefundEntity) {
    return refund.lines ?? this.refundsService.findLines(refund.id);
  }
}
