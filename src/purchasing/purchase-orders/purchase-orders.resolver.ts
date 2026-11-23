import { Args, ID, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ActiveUser } from '../../iam/authentication/decorators/active-user.decorator';
import { RequirePermission } from '../../iam/authorization/policy.decorators';
import { Supplier } from '../suppliers/supplier.entity';
import { SuppliersService } from '../suppliers/suppliers.service';
import { PurchaseOrder, PurchaseOrderPage } from './purchase-order.entity';
import {
  CancelPurchaseOrderInput,
  ClosePurchaseOrderInput,
  CreatePurchaseOrderInput,
  PurchaseOrdersArgs,
  ReceivePurchaseOrderInput,
  UpdatePurchaseOrderInput,
} from './purchase-order.input';
import { PurchaseOrdersService } from './purchase-orders.service';

@Resolver(() => PurchaseOrder)
export class PurchaseOrdersResolver {
  constructor(
    private readonly orders: PurchaseOrdersService,
    private readonly suppliers: SuppliersService,
  ) {}

  @RequirePermission('purchasing.view')
  @Query(() => PurchaseOrderPage, {
    description: 'Purchase orders, newest first, by status, supplier, location, variant or creation date (staff)',
  })
  purchaseOrders(@Args() { first, after, ...filter }: PurchaseOrdersArgs) {
    return this.orders.findMany(filter, first, after);
  }

  @RequirePermission('purchasing.view')
  @Query(() => PurchaseOrder, { description: 'A purchase order with its lines and receipts (staff)' })
  purchaseOrder(@Args('id', { type: () => ID }) id: string) {
    return this.orders.findOne(id);
  }

  @ResolveField(() => Supplier)
  supplier(@Parent() order: PurchaseOrder) {
    return this.suppliers.findOne(order.supplierId);
  }

  @RequirePermission('purchasing.manage')
  @Mutation(() => PurchaseOrder, { description: 'Create a DRAFT purchase order (staff)' })
  createPurchaseOrder(@ActiveUser('id') actorId: string, @Args('input') input: CreatePurchaseOrderInput) {
    return this.orders.create(input, actorId);
  }

  @RequirePermission('purchasing.manage')
  @Mutation(() => PurchaseOrder, {
    description: 'Edit a purchase order: lines, supplier and location only in DRAFT (staff)',
  })
  updatePurchaseOrder(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdatePurchaseOrderInput,
  ) {
    return this.orders.update(
      id,
      {
        ...(input.supplierId && { supplierId: input.supplierId }),
        ...(input.locationId && { locationId: input.locationId }),
        ...(input.lines && { lines: input.lines }),
        ...(input.expectedAt !== undefined && { expectedAt: input.expectedAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      actorId,
    );
  }

  @RequirePermission('purchasing.manage')
  @Mutation(() => PurchaseOrder, {
    description: 'Mark a DRAFT as sent to the supplier (no email is sent); its lines are frozen (staff)',
  })
  sendPurchaseOrder(@ActiveUser('id') actorId: string, @Args('id', { type: () => ID }) id: string) {
    return this.orders.send(id, actorId);
  }

  @RequirePermission('purchasing.receive')
  @Mutation(() => PurchaseOrder, {
    description:
      'Receive a delivery against a sent purchase order into its location; lot-tracked lines name their lot, ' +
      'serial-tracked lines their serials (staff)',
  })
  receivePurchaseOrder(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: ReceivePurchaseOrderInput,
  ) {
    return this.orders.receive(id, input.lines, actorId, input.note);
  }

  @RequirePermission('purchasing.manage')
  @Mutation(() => PurchaseOrder, {
    description: 'Cancel a DRAFT or SENT purchase order nothing was received on (staff)',
  })
  cancelPurchaseOrder(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input', { nullable: true }) input?: CancelPurchaseOrderInput,
  ) {
    return this.orders.cancel(id, actorId, input?.reason);
  }

  @RequirePermission('purchasing.manage')
  @Mutation(() => PurchaseOrder, {
    description: 'Close a partly received purchase order short: the outstanding units will not come (staff)',
  })
  closePurchaseOrder(
    @ActiveUser('id') actorId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: ClosePurchaseOrderInput,
  ) {
    return this.orders.close(id, input.reason, actorId);
  }
}
