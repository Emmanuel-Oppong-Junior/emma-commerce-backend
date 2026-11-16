import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Order } from './entities/order.entity';
import { Roles } from '../iam/authentication/decorators/roles.decorator';
import { Role } from '../users/enums/role.enum';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { CreateOrderInput } from './dto/create-order.input';
import { UpdateOrderStatusInput } from './dto/update-order-status.input';
import { UpdateShippingInput } from './dto/update-shipping.input';
import { OrdersService } from './order.service';
import { DiscountService } from '../discount/discount.service';
import { UsersLoader } from '../users/loaders/users.loader';
import { User } from '../users/entities/user.entity';
import { FulfillmentType, PaymentMethod } from '@prisma/client';

@Resolver(() => Order)
export class OrdersResolver {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly discountService: DiscountService,
    private readonly usersLoader: UsersLoader,
  ) {}

  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
  @Query(() => Order, {
    name: 'order',
    description: 'Retrieves a specific order by ID for the current user',
  })
  async getOrder(@ActiveUser('id') userId: string, @Args('orderId', { type: () => String }) orderId: string) {
    return this.ordersService.getOrder(userId, orderId);
  }

  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
  @Query(() => [Order], {
    name: 'userOrders',
    description: 'Retrieves all orders for the current user',
  })
  async getUserOrders(@ActiveUser('id') userId: string) {
    return this.ordersService.getUserOrders(userId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Query(() => [Order], {
    name: 'orders',
    description: 'Retrieves all orders (admin only)',
  })
  async getOrders() {
    return this.ordersService.getOrders();
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Query(() => Order, {
    name: 'viewOrder',
    description: 'Retrieves a specific order by ID (admin only)',
  })
  async viewOrder(@Args('id', { type: () => String }) orderId: string) {
    return this.ordersService.viewOrder(orderId);
  }

  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Order, {
    name: 'createOrder',
    description: 'Creates an order from the cart',
  })
  async createOrder(@ActiveUser('id') userId: string, @Args('input') input: CreateOrderInput) {
    return this.ordersService.createOrderFromCart(userId, {
      fulfillmentType: input.fulfillmentType as unknown as FulfillmentType,
      shippingAddressId: input.shippingAddressId,
      pickupLocationId: input.pickupLocationId,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      couponCode: input.couponCode,
      paymentMethod: input.paymentMethod as PaymentMethod,
    });
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Order, {
    name: 'updateShipping',
    description: 'Update tracking number and carrier for an order (admin only)',
  })
  async updateShipping(@ActiveUser('id') adminId: string, @Args('input') input: UpdateShippingInput) {
    return this.ordersService.updateShipping(input.orderId, input.trackingNumber, input.carrier, adminId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Order, {
    name: 'updateOrderStatus',
    description: 'Updates the status of an order',
  })
  async updateOrderStatus(@ActiveUser('id') adminId: string, @Args('input') input: UpdateOrderStatusInput) {
    return this.ordersService.updateOrderStatus(input.orderId, input.status, adminId);
  }

  @Roles(Role.USER)
  @Mutation(() => Order, {
    name: 'cancelOrder',
    description: "Cancels the authenticated user's own order and restores stock",
  })
  async cancelOrder(@ActiveUser('id') userId: string, @Args('orderId', { type: () => String }) orderId: string) {
    return this.ordersService.cancelOrder(userId, orderId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Order, {
    name: 'adminCancelOrder',
    description: 'Admin: cancel any order by ID and restore its stock',
  })
  async adminCancelOrder(@ActiveUser('id') adminId: string, @Args('orderId', { type: () => String }) orderId: string) {
    return this.ordersService.adminCancelOrder(orderId, adminId);
  }

  @Roles(Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Order, {
    name: 'deleteOrder',
    description: 'Soft-deletes an order and restores stock (admin only)',
  })
  async deleteOrder(@ActiveUser('id') adminId: string, @Args('orderId', { type: () => String }) orderId: string) {
    return this.ordersService.deleteOrder(orderId, adminId);
  }

  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
  @Mutation(() => Order)
  async finalizeOrder(@ActiveUser('id') userId: string, @Args('id', { type: () => String }) id: string) {
    await this.ordersService.getOrder(userId, id);
    return this.discountService.finalizeDiscountsForOrder(id);
  }

  @ResolveField(() => User, { nullable: true })
  async user(@Parent() order: Order) {
    return this.usersLoader.loader.load(order.userId);
  }
}
