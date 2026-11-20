import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ReturnsService } from './returns.service';
import { ReturnRequestEntity } from './entities/return-request.entity';
import { CreateReturnRequestInput } from './dto/create-return-request.input';
import { ApproveReturnInput, RejectReturnInput } from './dto/review-return.input';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { RequirePermission } from '../iam/authorization/policy.decorators';

@Resolver(() => ReturnRequestEntity)
export class ReturnsResolver {
  constructor(private readonly returnsService: ReturnsService) {}

  @Auth(AuthType.Bearer)
  @Mutation(() => ReturnRequestEntity, { description: 'Create a return request for a delivered order' })
  createReturnRequest(@ActiveUser('id') userId: string, @Args('input') input: CreateReturnRequestInput) {
    return this.returnsService.createReturnRequest(userId, input);
  }

  @RequirePermission('return.manage', 'order.refund')
  @Mutation(() => ReturnRequestEntity, { description: 'Approve a return request (admin only)' })
  approveReturn(@ActiveUser('id') adminUserId: string, @Args('input') input: ApproveReturnInput) {
    return this.returnsService.approveReturn(input, adminUserId);
  }

  @RequirePermission('return.manage')
  @Mutation(() => ReturnRequestEntity, { description: 'Reject a return request (admin only)' })
  rejectReturn(@ActiveUser('id') adminUserId: string, @Args('input') input: RejectReturnInput) {
    return this.returnsService.rejectReturn(input, adminUserId);
  }

  @RequirePermission('order.refund')
  @Mutation(() => ReturnRequestEntity, { description: 'Process a refund for an approved return (admin only)' })
  processRefund(
    @ActiveUser('id') adminUserId: string,
    @Args('returnRequestId', { type: () => ID }) returnRequestId: string,
  ) {
    return this.returnsService.processRefund(returnRequestId, adminUserId);
  }

  @Auth(AuthType.Bearer)
  @Query(() => [ReturnRequestEntity], { description: 'Get return requests for the current user' })
  myReturnRequests(@ActiveUser('id') userId: string) {
    return this.returnsService.findByUser(userId);
  }

  @RequirePermission('return.manage')
  @Query(() => [ReturnRequestEntity], { description: 'Get all return requests (admin only)' })
  returnRequests() {
    return this.returnsService.findAll();
  }
}
