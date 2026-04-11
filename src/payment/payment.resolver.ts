import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { PaymentService } from './payment.service';
import { Payment } from './entities/payment.entity';
import { Roles } from '../iam/authentication/decorators/roles.decorator';
import { Role } from '../users/enums/role.enum';
import { VerifyPaymentInput } from './dto/verify-payment.input';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';

@Resolver(() => Payment)
export class PaymentResolver {
  constructor(private readonly paymentService: PaymentService) {}

  @Roles(Role.USER)
  @Mutation(() => Payment)
  verifyPayment(@Args('verifyPaymentInput') verifyPaymentInput: VerifyPaymentInput, @ActiveUser('id') userId: string) {
    return this.paymentService.verifyPaymentAsUser(verifyPaymentInput.reference, userId);
  }

  @Roles(Role.USER)
  @Query(() => [Payment], { name: 'getMyPayments' })
  getMyPayments(@ActiveUser('id') userId: string) {
    return this.paymentService.getUserPayments(userId);
  }

  @Roles(Role.ADMIN)
  @Query(() => [Payment], { name: 'getUserPayment' })
  getUserPayments(@Args('userId', { type: () => String }) userId: string) {
    return this.paymentService.getUserPayments(userId);
  }

  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
  @Query(() => Payment, { name: 'payment' })
  getPayment(
    @Args('id', { type: () => String }) id: string,
    @ActiveUser('id') userId: string,
    @ActiveUser('role') userRole: Role,
  ) {
    return this.paymentService.getPayment(id, userId, userRole);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Payment, {
    description: 'Record cash collection for a cash-on-delivery order. Marks payment as complete and order as DELIVERED.',
  })
  recordCodPayment(
    @Args('orderId', { type: () => String }) orderId: string,
    @ActiveUser('id') adminId: string,
  ) {
    return this.paymentService.recordCodPayment(orderId, adminId);
  }

  @Roles(Role.ADMIN)
  @Mutation(() => Payment)
  softDeletePayment(@Args('id', { type: () => String }) id: string) {
    return this.paymentService.softDelete(id);
  }

  @Roles(Role.ADMIN)
  @Mutation(() => Payment)
  restorePayment(@Args('id', { type: () => String }) id: string) {
    return this.paymentService.restore(id);
  }

  @Roles(Role.ADMIN)
  @Mutation(() => Payment)
  removePayment(@Args('id', { type: () => String }) id: string) {
    return this.paymentService.remove(id);
  }
}
