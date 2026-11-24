import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { CustomerOnly, RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';
import { RefundEntity } from './entities/refund.entity';
import { CustomerReturn, CustomerReturnPage, ReturnRequestEntity, ReturnRequestPage } from './entities/return.entities';
import {
  AcceptReturnOutsidePolicyInput,
  InspectReturnInput,
  MyReturnsArgs,
  ReceiveReturnInput,
  RefundReturnInput,
  RejectReturnInput,
  RequestReturnInput,
  ReturnsArgs,
  ReturnStepInput,
} from './dto/return.inputs';
import { ReturnsService } from './returns.service';

@Resolver(() => ReturnRequestEntity)
export class ReturnsResolver {
  constructor(private readonly returnsService: ReturnsService) {}

  @CustomerOnly()
  @Mutation(() => CustomerReturn, {
    description:
      'Return delivered units of your own order: per line a quantity and reason, optional photos, and for an exchange ' +
      'the variant wanted. BAD_REQUEST (reason NOT_RETURNABLE, OUTSIDE_RETURN_WINDOW, NOT_DELIVERED, EXCHANGE_NOT_ALLOWED) or CONFLICT (RETURN_QUANTITY_EXCEEDED)',
  })
  requestReturn(@ActiveUser('id') userId: string, @Args('input') input: RequestReturnInput) {
    return this.returnsService.requestReturn(userId, {
      orderId: input.orderId,
      resolution: input.resolution,
      lines: input.lines,
    });
  }

  @CustomerOnly()
  @Mutation(() => CustomerReturn, { description: 'Withdraw your own return before its goods arrive back' })
  cancelReturn(@ActiveUser('id') userId: string, @Args('returnRequestId', { type: () => ID }) returnRequestId: string) {
    return this.returnsService.cancelReturn(userId, returnRequestId);
  }

  @CustomerOnly()
  @Query(() => CustomerReturnPage, { description: 'Your returns, newest first' })
  myReturns(@ActiveUser('id') userId: string, @Args() { first, after }: MyReturnsArgs) {
    return this.returnsService.findMyReturns(userId, first, after);
  }

  @RequirePermission('return.manage')
  @Query(() => ReturnRequestPage, { description: 'Return requests, newest first, by status, order or date (staff)' })
  returns(@Args() { first, after, ...filter }: ReturnsArgs) {
    return this.returnsService.findReturns(filter, first, after);
  }

  @RequirePermission('return.manage')
  @Query(() => ReturnRequestEntity, { description: 'A return request with its lines and history (staff)' })
  returnRequest(@Args('id', { type: () => ID }) id: string) {
    return this.returnsService.findReturn(id);
  }

  @RequirePermission('return.manage', 'return.override')
  @Mutation(() => ReturnRequestEntity, {
    description:
      "Create an APPROVED return for an order's customer outside the return window or for a non-returnable product, " +
      'with a reason (staff, audited); the units must still have been delivered and not be refunded or returned',
  })
  acceptReturnOutsidePolicy(@ActiveUser('id') actorId: string, @Args('input') input: AcceptReturnOutsidePolicyInput) {
    return this.returnsService.acceptReturnOutsidePolicy(
      {
        orderId: input.orderId,
        resolution: input.resolution,
        lines: input.lines,
        overrideReason: input.overrideReason,
        staffNote: input.staffNote,
      },
      actorId,
    );
  }

  @RequirePermission('return.manage')
  @Mutation(() => ReturnRequestEntity, { description: 'Approve a requested return (staff)' })
  approveReturn(@ActiveUser('id') actorId: string, @Args('input') input: ReturnStepInput) {
    return this.returnsService.approveReturn(input.returnRequestId, input.staffNote, actorId);
  }

  @RequirePermission('return.manage')
  @Mutation(() => ReturnRequestEntity, {
    description: 'Refuse a requested return, or an approved one whose goods never arrived, with a reason (staff)',
  })
  rejectReturn(@ActiveUser('id') actorId: string, @Args('input') input: RejectReturnInput) {
    return this.returnsService.rejectReturn(input.returnRequestId, input.reason, input.staffNote, actorId);
  }

  @RequirePermission('return.manage')
  @Mutation(() => ReturnRequestEntity, {
    description: 'Record the goods of an approved return arriving back: units received per line (staff)',
  })
  receiveReturn(@ActiveUser('id') actorId: string, @Args('input') input: ReceiveReturnInput) {
    return this.returnsService.receiveReturn(input.returnRequestId, input.lines, input.staffNote, actorId);
  }

  @RequirePermission('return.manage', 'inventory.adjust')
  @Mutation(() => ReturnRequestEntity, {
    description:
      "Decide per line how many received units go back into stock (at the order's location) and how many are written " +
      'off (staff)',
  })
  inspectReturn(@ActiveUser('id') actorId: string, @Args('input') input: InspectReturnInput) {
    return this.returnsService.inspectReturn(input.returnRequestId, input.lines, input.staffNote, actorId);
  }

  @RequirePermission('order.refund')
  @RequireStepUp()
  @Mutation(() => ReturnRequestEntity, {
    description:
      "Refund an inspected return: the units received, at what the order stored for them, through the payment's " +
      'provider (cash-on-delivery: cash handed back); the delivery fee only with refundShipping. A legacy whole-order ' +
      'request refunds its approved amount. Sending again resends a refund that was refused (staff)',
  })
  refundReturn(@ActiveUser('id') actorId: string, @Args('input') input: RefundReturnInput) {
    return this.returnsService.refundReturn(
      input.returnRequestId,
      { refundShipping: input.refundShipping, staffNote: input.staffNote },
      actorId,
    );
  }

  @RequirePermission('return.manage')
  @Mutation(() => ReturnRequestEntity, {
    description:
      'Settle an inspected exchange with a replacement order at no charge (staff). BAD_REQUEST with reason ' +
      'EXCHANGE_NOT_ALLOWED or EXCHANGE_OUT_OF_STOCK when it cannot be done: refund instead',
  })
  exchangeReturn(@ActiveUser('id') actorId: string, @Args('input') input: ReturnStepInput) {
    return this.returnsService.exchangeReturn(input.returnRequestId, input.staffNote, actorId);
  }

  @ResolveField(() => RefundEntity, { nullable: true, description: 'The refund of this return, once recorded' })
  refund(@Parent() request: ReturnRequestEntity) {
    return this.returnsService.findRefund(request.id);
  }
}
