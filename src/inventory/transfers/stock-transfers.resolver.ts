import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { StockTransfer, StockTransferLine, StockTransferPage, VariantInTransit } from './stock-transfer.entity';
import {
  CancelStockTransferInput,
  CreateStockTransferInput,
  ReceiveStockTransferInput,
  StockTransfersArgs,
} from './stock-transfer.input';
import { StockTransfersService } from './stock-transfers.service';

@Resolver(() => StockTransfer)
export class StockTransfersResolver {
  constructor(private readonly transfers: StockTransfersService) {}

  @RequirePermission('inventory.view')
  @Query(() => StockTransferPage, {
    description: 'Stock transfers, newest first, optionally by status, location or variant (staff)',
  })
  stockTransfers(@Args() { status, locationId, variantId, first, after }: StockTransfersArgs) {
    return this.transfers.findMany({ status, locationId, variantId }, first, after);
  }

  @RequirePermission('inventory.view')
  @Query(() => StockTransfer, { description: 'A stock transfer (staff)' })
  stockTransfer(@Args('id', { type: () => ID }) id: string) {
    return this.transfers.findOne(id);
  }

  @RequirePermission('inventory.view')
  @Query(() => [VariantInTransit], {
    description: 'Units dispatched and not yet received, per variant; only variants with some in transit (staff)',
  })
  stockInTransit(@Args('variantIds', { type: () => [ID], nullable: true }) variantIds?: string[]) {
    return this.transfers.inTransit(variantIds);
  }

  @RequirePermission('inventory.transfer')
  @Mutation(() => StockTransfer, { description: 'Create a DRAFT transfer between two active locations (staff)' })
  createStockTransfer(@ActiveUser('id') actorId: string, @Args('input') input: CreateStockTransferInput) {
    return this.transfers.create(input, actorId);
  }

  @RequirePermission('inventory.transfer')
  @Mutation(() => StockTransfer, {
    description: 'Dispatch a DRAFT transfer: its units leave the source and are in transit (staff)',
  })
  dispatchStockTransfer(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.transfers.dispatch(id, actorId);
  }

  @RequirePermission('inventory.transfer')
  @Mutation(() => StockTransfer, {
    description: 'Receive a dispatched transfer at the destination, recording any shortfall per line (staff)',
  })
  receiveStockTransfer(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input', { nullable: true }) input?: ReceiveStockTransferInput,
  ) {
    return this.transfers.receive(id, input?.lines ?? [], actorId);
  }

  @RequirePermission('inventory.transfer')
  @Mutation(() => StockTransfer, { description: 'Cancel a DRAFT transfer; nothing has moved yet (staff)' })
  cancelStockTransfer(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input', { nullable: true }) input?: CancelStockTransferInput,
  ) {
    return this.transfers.cancel(id, actorId, input?.reason);
  }
}

@Resolver(() => StockTransferLine)
export class StockTransferLineResolver {
  @ResolveField(() => Int, {
    nullable: true,
    description: 'quantity - receivedQuantity once received: units lost on the way',
  })
  variance(@Parent() line: StockTransferLine): number | null {
    return line.receivedQuantity === null ? null : line.quantity - line.receivedQuantity;
  }
}
