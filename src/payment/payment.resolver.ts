import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { PaymentService } from './payment.service';
import { Payment } from './entities/payment.entity';
import { VerifyPaymentInput } from './dto/verify-payment.input';
import { RecordCodPaymentInput } from './dto/record-cod-payment.input';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { ActiveAccess, CustomerOnly, RequirePermission } from '../iam/authorization/policy.decorators';
import { hasPermission, StaffAccess } from '../iam/authorization/staff-access';

@Resolver(() => Payment)
export class PaymentResolver {
  constructor(private readonly paymentService: PaymentService) {}

  @CustomerOnly()
  @Mutation(() => Payment)
  verifyPayment(@Args('verifyPaymentInput') verifyPaymentInput: VerifyPaymentInput, @ActiveUser('id') userId: string) {
    return this.paymentService.verifyPaymentAsUser(verifyPaymentInput.reference, userId);
  }

  @RequirePermission('payment.view')
  @Query(() => [Payment], { name: 'payments' })
  getPayments() {
    return this.paymentService.getAllPayments();
  }

  @CustomerOnly()
  @Query(() => [Payment], { name: 'getMyPayments' })
  getMyPayments(@ActiveUser('id') userId: string) {
    return this.paymentService.getUserPayments(userId);
  }

  @RequirePermission('payment.view')
  @Query(() => [Payment], { name: 'getUserPayment' })
  getUserPayments(@Args('userId', { type: () => String }) userId: string) {
    return this.paymentService.getUserPayments(userId);
  }

  @Auth(AuthType.Bearer)
  @Query(() => Payment, { name: 'payment' })
  getPayment(
    @Args('id', { type: () => String }) id: string,
    @ActiveUser('id') userId: string,
    @ActiveAccess() access: StaffAccess,
  ) {
    return this.paymentService.getPayment(id, userId, hasPermission(access, 'payment.view'));
  }

  @RequirePermission('payment.record')
  @Mutation(() => Payment, {
    description:
      'Record the order total as cash collected for a dispatched cash-on-delivery order (out for delivery or ready for pickup). The collector (riderId) is a rider (role with delivery.ride) for a delivery, any active staff member at the pickup counter. Captures the payment, delivers the shipment and completes the order. BAD_REQUEST for a non-COD order, a collector who is not active staff (reason RIDER_NOT_STAFF) or, for a delivery, not a rider (NOT_A_RIDER), an amount other than the grand total (COLLECTION_AMOUNT_MISMATCH) or a collectedAt in the future or before dispatch (INVALID_COLLECTION_TIME); CONFLICT for the wrong status or an already-recorded payment. Nothing changes when refused.',
  })
  recordCodPayment(@Args('input') input: RecordCodPaymentInput, @ActiveUser('id') adminId: string) {
    return this.paymentService.recordCodPayment(input, adminId);
  }

  @RequirePermission('payment.manage')
  @Mutation(() => Payment)
  softDeletePayment(@Args('id', { type: () => String }) id: string) {
    return this.paymentService.softDelete(id);
  }

  @RequirePermission('payment.manage')
  @Mutation(() => Payment)
  restorePayment(@Args('id', { type: () => String }) id: string) {
    return this.paymentService.restore(id);
  }
}
