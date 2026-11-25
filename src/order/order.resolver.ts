import { Args, Context, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Request } from 'express';
import { Order } from './entities/order.entity';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { CreateOrderInput } from './dto/create-order.input';
import { CheckoutQuoteInput } from './dto/checkout-quote.input';
import { CheckoutQuote } from './entities/checkout-quote.entity';
import { OrderStatusEvent } from './entities/order-status-event.entity';
import { Shipment } from './entities/shipment.entity';
import { PaymentIntentStatusEnum } from './enums/order.enum';
import { OrdersService } from './order.service';
import { UsersLoader } from '../users/loaders/users.loader';
import { User } from '../users/entities/user.entity';
import { FulfillmentType, PaymentMethod } from '../generated/prisma/client';
import { ownerOrAdmin } from '../iam/authorization/owner-or-admin.field-middleware';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { RequirePermission, CustomerOnly } from '../iam/authorization/policy.decorators';

@Resolver(() => Order)
export class OrdersResolver {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly usersLoader: UsersLoader,
  ) {}

  @Auth(AuthType.Bearer)
  @Query(() => Order, {
    name: 'order',
    description: 'Retrieves a specific order by ID for the current user',
  })
  async getOrder(@ActiveUser('id') userId: string, @Args('orderId', { type: () => String }) orderId: string) {
    return this.ordersService.getOrder(userId, orderId);
  }

  @Auth(AuthType.Bearer)
  @Query(() => [Order], {
    name: 'userOrders',
    description: 'Retrieves all orders for the current user',
  })
  async getUserOrders(@ActiveUser('id') userId: string) {
    return this.ordersService.getUserOrders(userId);
  }

  @RequirePermission('order.view')
  @Query(() => [Order], {
    name: 'orders',
    description: 'Retrieves all orders (admin only)',
  })
  async getOrders() {
    return this.ordersService.getOrders();
  }

  @RequirePermission('order.view')
  @Query(() => Order, {
    name: 'viewOrder',
    description: 'Retrieves a specific order by ID (admin only)',
  })
  async viewOrder(@Args('id', { type: () => String }) orderId: string) {
    return this.ordersService.viewOrder(orderId);
  }

  @Auth(AuthType.Bearer)
  @Query(() => CheckoutQuote, {
    description:
      "Prices the current user's cart for checkout with the chosen fulfilment and coupon: the full breakdown and the " +
      'quoteHash createOrder needs. Writes nothing',
  })
  async checkoutQuote(@ActiveUser('id') userId: string, @Args('input') input: CheckoutQuoteInput) {
    return this.ordersService.checkoutQuote(userId, {
      fulfillmentType: input.fulfillmentType as unknown as FulfillmentType,
      shippingAddressId: input.shippingAddressId,
      pickupLocationId: input.pickupLocationId,
      couponCode: input.couponCode,
      paymentMethod: input.paymentMethod as PaymentMethod,
      serviceLevel: input.serviceLevel,
      deliverySlot: input.deliverySlot,
      redeemPoints: input.redeemPoints,
    });
  }

  @Auth(AuthType.Bearer)
  @Mutation(() => Order, {
    name: 'createOrder',
    description:
      'Creates an order from the cart at the price of the checkoutQuote whose quoteHash it is sent; CONFLICT with ' +
      'reason QUOTE_CHANGED if the cart no longer prices to it; FORBIDDEN with reason VELOCITY_LIMIT when too many ' +
      'orders came from the same account, phone number or network in a short time',
  })
  async createOrder(
    @ActiveUser('id') userId: string,
    @Args('input') input: CreateOrderInput,
    @Context('req') req: Request,
  ) {
    return this.ordersService.createOrderFromCart(userId, {
      fulfillmentType: input.fulfillmentType as unknown as FulfillmentType,
      shippingAddressId: input.shippingAddressId,
      pickupLocationId: input.pickupLocationId,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      couponCode: input.couponCode,
      paymentMethod: input.paymentMethod as PaymentMethod,
      serviceLevel: input.serviceLevel,
      deliverySlot: input.deliverySlot,
      redeemPoints: input.redeemPoints,
      quoteHash: input.quoteHash,
      clientIp: req.ip,
    });
  }

  @CustomerOnly()
  @Mutation(() => Order, {
    name: 'cancelOrder',
    description: "Cancels the authenticated user's own order and restores stock",
  })
  async cancelOrder(
    @ActiveUser('id') userId: string,
    @Args('orderId', { type: () => String }) orderId: string,
    @Args('reason', { type: () => String, nullable: true }) reason?: string,
  ) {
    return this.ordersService.cancelOrder(userId, orderId, reason);
  }

  @RequirePermission('order.manage')
  @Mutation(() => Order, {
    name: 'adminCancelOrder',
    description: 'Admin: cancel any order by ID and restore its stock',
  })
  async adminCancelOrder(
    @ActiveUser('id') adminId: string,
    @Args('orderId', { type: () => String }) orderId: string,
    @Args('reason', { type: () => String, nullable: true }) reason?: string,
  ) {
    return this.ordersService.adminCancelOrder(orderId, adminId, reason);
  }

  @RequirePermission('order.manage')
  @Mutation(() => Order, {
    name: 'deleteOrder',
    description: 'Soft-deletes an order and restores stock (admin only)',
  })
  async deleteOrder(@ActiveUser('id') adminId: string, @Args('orderId', { type: () => String }) orderId: string) {
    return this.ordersService.deleteOrder(orderId, adminId);
  }

  // Every order query already limits customers to their own orders, so the timeline needs no extra check.
  @ResolveField(() => [OrderStatusEvent], { description: 'Status history (tracking timeline), oldest first' })
  async timeline(@Parent() order: Order & { statusEvents?: OrderStatusEvent[] }) {
    return order.statusEvents ?? this.ordersService.getTimeline(order.id);
  }

  @ResolveField(() => [Shipment])
  async shipments(@Parent() order: Order) {
    return order.shipments ?? this.ordersService.getShipments(order.id);
  }

  @ResolveField(() => PaymentIntentStatusEnum, { nullable: true })
  async paymentStatus(@Parent() order: Order & { paymentIntent?: { status: string } | null }) {
    if (order.paymentIntent !== undefined) return order.paymentIntent?.status ?? null;
    return this.ordersService.getPaymentStatus(order.id);
  }

  @ResolveField(() => User, { nullable: true, middleware: [ownerOrAdmin<Order>((order) => order.userId)] })
  async user(@Parent() order: Order) {
    return order.userId === null ? null : this.usersLoader.loader.load(order.userId);
  }
}
