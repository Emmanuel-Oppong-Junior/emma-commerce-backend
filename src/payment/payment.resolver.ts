import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { PaymentService } from './payment.service';
import { Payment } from './entities/payment.entity';
import { VerifyPaymentInput } from './dto/verify-payment.input';
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
      'Record the order total as cash collected for a SHIPPED cash-on-delivery order (delivery or pickup). Marks the payment complete and the order DELIVERED. Any other order is refused (CONFLICT for the wrong status or an already-recorded payment, BAD_REQUEST for a non-COD order) and nothing changes.',
  })
  recordCodPayment(@Args('orderId', { type: () => String }) orderId: string, @ActiveUser('id') adminId: string) {
    return this.paymentService.recordCodPayment(orderId, adminId);
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
