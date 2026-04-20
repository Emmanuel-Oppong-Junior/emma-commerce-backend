import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CartService } from '../cart/cart.service';
import {
  Cart,
  CartItem,
  FulfillmentType,
  Order,
  OrderItem,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  Product,
} from '@prisma/client';
import { AuditService } from '../commons/audit.service';
import { OrdersRepository } from './order.repository';
import { CouponsService } from '../coupons/coupons.service';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ShippingZonesService } from '../shipping-zones/shipping-zones.service';
import { PickupLocationsService } from '../pickup-locations/pickup-locations.service';
import { ReturnsService } from '../returns/returns.service';

interface CreateOrderParams {
  fulfillmentType: FulfillmentType;
  shippingAddressId?: string;
  pickupLocationId?: string;
  contactEmail: string;
  contactPhone: string;
  couponCode?: string;
  paymentMethod?: PaymentMethod;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly ordersRepository: OrdersRepository,
    private readonly cartService: CartService,
    private readonly auditService: AuditService,
    private readonly couponsService: CouponsService,
    private readonly inventoryService: InventoryService,
    private readonly notificationsService: NotificationsService,
    private readonly shippingZonesService: ShippingZonesService,
    private readonly pickupLocationsService: PickupLocationsService,
    private readonly returnsService: ReturnsService,
  ) {}

  /**
   * Creates a new order from the user's active cart.
   * Supports DELIVERY (requires shippingAddressId, calculates shipping fee by city)
   * and PICKUP (requires pickupLocationId, no shipping fee).
   */
  async createOrderFromCart(userId: string, params: CreateOrderParams): Promise<Order & { items: OrderItem[] }> {
    const cart = await this.ensureValidCart(userId);
    await this.ensureUserCanOrder(userId, cart);

    if (params.fulfillmentType === FulfillmentType.DELIVERY) {
      return this.createDeliveryOrder(userId, cart, params);
    }
    return this.createPickupOrder(userId, cart, params);
  }

  private async createDeliveryOrder(
    userId: string,
    cart: Cart & { items: CartItem[] },
    params: CreateOrderParams,
  ): Promise<Order & { items: OrderItem[] }> {
    if (!params.shippingAddressId) {
      throw new BadRequestException('shippingAddressId is required for DELIVERY orders');
    }
    const address = await this.ensureValidShippingAddress(userId, params.shippingAddressId);
    const shippingFee = await this.shippingZonesService.getFeeForCity(address.city);
    const orderDetails = await this.buildOrderDetails(cart.items, userId, Number(shippingFee), params.couponCode);

    const order = await this.saveOrderAndUpdateInventory(userId, cart.id, {
      ...orderDetails,
      paymentMethod: params.paymentMethod ?? PaymentMethod.ONLINE,
      contactEmail: params.contactEmail,
      contactPhone: params.contactPhone,
      fulfillmentType: FulfillmentType.DELIVERY,
      shippingAddressId: params.shippingAddressId,
      shippingAddressSnapshot: {
        street: address.street,
        city: address.city,
        state: address.state,
        zipCode: address.zipCode,
        country: address.country,
      },
    });

    this.sendOrderConfirmationEmail(userId, order);
    return order;
  }

  private async createPickupOrder(
    userId: string,
    cart: Cart & { items: CartItem[] },
    params: CreateOrderParams,
  ): Promise<Order & { items: OrderItem[] }> {
    if (!params.pickupLocationId) {
      throw new BadRequestException('pickupLocationId is required for PICKUP orders');
    }

    const orderDetails = await this.buildOrderDetails(cart.items, userId, 0, params.couponCode);

    const order = await this.saveOrderAndUpdateInventory(userId, cart.id, {
      ...orderDetails,
      paymentMethod: params.paymentMethod ?? PaymentMethod.ONLINE,
      contactEmail: params.contactEmail,
      contactPhone: params.contactPhone,
      fulfillmentType: FulfillmentType.PICKUP,
      pickupLocationId: params.pickupLocationId,
    });

    this.sendOrderConfirmationEmail(userId, order);
    return order;
  }

  /**
   * Retrieves a specific order owned by the given user.
   */
  async getOrder(userId: string, orderId: string): Promise<Order & { items: OrderItem[] }> {
    return this.retrieveUserOrder(userId, orderId);
  }

  /**
   * Retrieves an order by ID without any ownership check (admin use).
   */
  async viewOrder(orderId: string) {
    return this.ordersRepository.findById(orderId, { items: { include: { product: true } } });
  }

  /**
   * Retrieves all orders placed by a specific user.
   */
  async getUserOrders(userId: string): Promise<(Order & { items: OrderItem[] })[]> {
    return this.ordersRepository.findByUser(userId);
  }

  /**
   * Retrieves all orders in the system (admin only).
   */
  async getOrders(): Promise<Order[]> {
    return this.ordersRepository.findAll();
  }

  /**
   * Cancels all PENDING online orders that have had no payment initiated within the given window.
   */
  async expireAbandonedOrders(expiryHours: number): Promise<number> {
    const cutoff = new Date(Date.now() - expiryHours * 60 * 60 * 1000);
    const orders = await this.ordersRepository.findExpiredPendingOrders(cutoff);
    for (const order of orders) {
      await this.cancelOrderAndRestoreStock(order);
    }
    return orders.length;
  }

  /**
   * Updates the status of an order and emits shipping notifications when appropriate.
   */
  async updateOrderStatus(
    orderId: string,
    status: OrderStatus,
    adminUserId?: string,
  ): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveOrder(orderId);
    const updated = await this.ordersRepository.updateStatus(orderId, status);
    await this.auditService.log({
      entity: 'Order',
      entityId: orderId,
      action: 'STATUS_CHANGE',
      userId: adminUserId,
      details: { from: order.status as string, to: status as string },
    });
    if (status === 'SHIPPED' || status === 'DELIVERED') {
      this.sendOrderStatusEmail(
        order.userId,
        orderId,
        status,
        (updated as Order & { trackingNumber?: string | null }).trackingNumber ?? undefined,
      );
    }
    if (status === OrderStatus.CANCELLED) {
      await this.requestReturnIfPaidOnline(order);
    }
    return updated;
  }

  /**
   * Cancels an order owned by the requesting user and restores the reserved stock.
   */
  async cancelOrder(userId: string, orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveUserOrder(userId, orderId);
    this.ensureOrderCanBeCancelled(order);
    const cancelled = await this.cancelOrderAndRestoreStock(order);
    await this.requestReturnIfPaidOnline(order);
    return cancelled;
  }

  /**
   * Cancels any order without an ownership check (admin only) and restores the reserved stock.
   */
  async adminCancelOrder(orderId: string, adminUserId?: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveOrder(orderId);
    this.ensureOrderCanBeCancelled(order);
    const cancelled = await this.cancelOrderAndRestoreStock(order);
    await this.auditService.log({
      entity: 'Order',
      entityId: orderId,
      action: 'STATUS_CHANGE',
      details: { to: 'CANCELLED' },
      userId: adminUserId,
    });
    await this.requestReturnIfPaidOnline(order);
    return cancelled;
  }

  /**
   * Transitions a pending order to PROCESSING status after confirming the user owns it.
   */
  async markOrderAsPaid(userId: string, orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveUserOrder(userId, orderId);
    if ((order as Order & { paymentMethod: PaymentMethod }).paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
      throw new BadRequestException(`Order "${orderId}" uses cash on delivery and cannot be marked as paid online`);
    }
    this.ensureOrderCanBePaid(order);
    return this.ordersRepository.updateStatus(orderId, 'PROCESSING');
  }

  /**
   * Soft-deletes an order and restores its reserved stock (admin only).
   */
  async deleteOrder(orderId: string, adminUserId?: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveOrder(orderId);
    const result = await this.softDeleteOrder(order);
    await this.auditService.log({
      entity: 'Order',
      entityId: orderId,
      action: 'DELETE',
      userId: adminUserId,
    });
    return result;
  }

  /**
   * Updates the shipping carrier and tracking number for an order and notifies the customer.
   */
  async updateShipping(
    orderId: string,
    trackingNumber?: string,
    carrier?: string,
    adminUserId?: string,
  ): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveOrder(orderId);
    const updated = await this.ordersRepository.updateShipping(orderId, trackingNumber, carrier);
    await this.auditService.log({
      entity: 'Order',
      entityId: orderId,
      action: 'UPDATE',
      userId: adminUserId,
      details: { trackingNumber, carrier },
    });
    if (trackingNumber) {
      this.sendOrderStatusEmail(order.userId, orderId, 'SHIPPED', trackingNumber);
    }
    return updated;
  }

  private async ensureValidCart(userId: string): Promise<Cart & { items: CartItem[] }> {
    const cart = await this.cartService.getCartOrThrow(userId);
    if (cart.items.length === 0) throw new NotFoundException(`Cart for user "${userId}" is empty`);
    return cart;
  }

  private async ensureValidShippingAddress(userId: string, shippingAddressId: string) {
    const address = await this.ordersRepository.findAddressForUser(shippingAddressId, userId);
    if (!address) {
      throw new NotFoundException(`Shipping address "${shippingAddressId}" not found for user "${userId}"`);
    }
    return address;
  }

  private async ensureUserCanOrder(userId: string, cart: Cart & { items: CartItem[] }): Promise<void> {
    const user = await this.ordersRepository.findUserById(userId);
    if (!user || !user.isActive) throw new BadRequestException(`User "${userId}" is not eligible to place an order`);
    if (cart.items.length > 50) throw new BadRequestException('Order exceeds maximum item limit of 50');
  }

  private async buildOrderDetails(
    cartItems: CartItem[],
    userId: string,
    shippingFee: number,
    couponCode?: string,
  ): Promise<{
    orderItems: OrderItem[];
    totalAmount: Prisma.Decimal;
    couponId?: string;
    couponDiscount?: number;
  }> {
    const orderItems = await this.createOrderItems(cartItems);
    const subtotal = this.computeSubtotal(orderItems);

    let couponId: string | undefined;
    let couponDiscount = 0;
    if (couponCode) {
      const { discountAmount, coupon } = await this.couponsService.validateCoupon(couponCode, userId, subtotal);
      couponId = coupon.id;
      couponDiscount = discountAmount;
    }

    const totalAmount = new Prisma.Decimal(Math.max(0, subtotal + shippingFee - couponDiscount).toFixed(2));
    return { orderItems, totalAmount, couponId, couponDiscount: couponDiscount || undefined };
  }

  private async createOrderItems(cartItems: CartItem[]): Promise<OrderItem[]> {
    const orderItems: OrderItem[] = [];
    for (const item of cartItems) {
      const product = await this.checkProductAvailability(item);
      orderItems.push({
        productId: item.productId,
        quantity: item.quantity,
        priceAtOrder: product.price as unknown as Prisma.Decimal,
        originalPrice: product.price as unknown as Prisma.Decimal,
      } as OrderItem);
    }
    return orderItems;
  }

  private async checkProductAvailability(item: CartItem): Promise<Product> {
    const product = await this.ordersRepository.findProductById(item.productId);
    if (!product) throw new NotFoundException(`Product "${item.productId}" not found`);
    if (product.quantity < item.quantity) {
      throw new BadRequestException(
        `Insufficient stock for "${product.name}": ${product.quantity} available, ${item.quantity} requested`,
      );
    }
    return product;
  }

  private computeSubtotal(orderItems: OrderItem[]): number {
    return orderItems.reduce((sum, item) => sum + Number(item.priceAtOrder) * item.quantity, 0);
  }

  private async saveOrderAndUpdateInventory(
    userId: string,
    cartId: string,
    orderDetails: {
      orderItems: OrderItem[];
      totalAmount: Prisma.Decimal;
      couponId?: string;
      couponDiscount?: number;
      paymentMethod?: PaymentMethod;
      contactEmail: string;
      contactPhone: string;
      fulfillmentType: FulfillmentType;
      shippingAddressId?: string;
      pickupLocationId?: string;
      shippingAddressSnapshot?: Record<string, unknown>;
    },
  ): Promise<Order & { items: OrderItem[] }> {
    return this.ordersRepository.runTransaction(async (tx) => {
      for (const item of orderDetails.orderItems) {
        const product = await this.ordersRepository.decrementProductStock(tx, item.productId, item.quantity);
        if (product.quantity < 0) {
          throw new BadRequestException(`Insufficient stock for product "${item.productId}" — please review your cart`);
        }
        await this.inventoryService.logInventoryChange(tx, {
          productId: item.productId,
          action: 'ORDER_DEDUCTION',
          quantityChange: -item.quantity,
          quantityAfter: product.quantity,
          reason: `Order placed by user ${userId}`,
          actorId: userId,
        });
      }

      const isCod = orderDetails.paymentMethod === PaymentMethod.CASH_ON_DELIVERY;
      const newOrder = await this.ordersRepository.create(tx, userId, {
        ...orderDetails,
        initialStatus: isCod ? OrderStatus.PROCESSING : OrderStatus.PENDING,
      });

      if (orderDetails.couponId) {
        await this.couponsService.recordUsage(tx, orderDetails.couponId, userId, newOrder.id);
      }

      await this.ordersRepository.clearCartItems(tx, cartId);
      return newOrder;
    });
  }

  private async retrieveUserOrder(userId: string, orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.ordersRepository.findById(orderId, { items: { include: { product: true } } });
    if (order?.userId !== userId) {
      throw new NotFoundException(`Order "${orderId}" not found`);
    }
    return order;
  }

  private ensureOrderCanBeCancelled(order: Order & { items: OrderItem[] }): void {
    if (order.status === 'SHIPPED' || order.status === 'DELIVERED') {
      throw new BadRequestException(`Order "${order.id}" cannot be cancelled; current status: ${order.status}`);
    }
  }

  private async cancelOrderAndRestoreStock(
    order: Order & { items: OrderItem[] },
  ): Promise<Order & { items: OrderItem[] }> {
    return this.ordersRepository.runTransaction(async (tx) => {
      for (const item of order.items) {
        const product = await this.ordersRepository.updateProductStock(tx, item.productId, item.quantity);
        await this.inventoryService.logInventoryChange(tx, {
          productId: item.productId,
          action: 'RETURN_RESTORE',
          quantityChange: item.quantity,
          quantityAfter: product.quantity,
          reason: `Order ${order.id} cancelled`,
        });
      }
      return this.ordersRepository.updateStatus(order.id, 'CANCELLED');
    });
  }

  private ensureOrderCanBePaid(order: Order & { items: OrderItem[] }): void {
    if (order.status !== 'PENDING') {
      throw new BadRequestException(`Order "${order.id}" cannot be paid; current status: ${order.status}`);
    }
  }

  private async retrieveOrder(orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.ordersRepository.findById(orderId, { items: true });
    if (!order) throw new NotFoundException(`Order "${orderId}" not found`);
    return order;
  }

  private async softDeleteOrder(order: Order & { items: OrderItem[] }): Promise<Order & { items: OrderItem[] }> {
    return this.ordersRepository.runTransaction(async (tx) => {
      for (const item of order.items) {
        await this.ordersRepository.updateProductStock(tx, item.productId, item.quantity);
      }
      return this.ordersRepository.softDelete(order.id);
    });
  }

  private async requestReturnIfPaidOnline(order: Order & { items: OrderItem[] }): Promise<void> {
    if (order.paymentMethod !== PaymentMethod.ONLINE) return;
    const payment = await this.ordersRepository.findPaymentByOrderId(order.id);
    if (payment?.status !== PaymentStatus.COMPLETED) return;
    await this.returnsService.createSystemReturnRequest(
      order.id,
      order.userId,
      'Automatic refund request for cancelled paid order',
    );
  }

  private sendOrderConfirmationEmail(userId: string, order: Order): void {
    void this.ordersRepository.findUserById(userId).then((user) => {
      if (user?.email) {
        this.notificationsService.sendOrderConfirmation(user.email, order.id, Number(order.totalAmount));
      }
    });
  }

  private sendOrderStatusEmail(userId: string, orderId: string, status: string, trackingNumber?: string): void {
    void this.ordersRepository.findUserById(userId).then((user) => {
      if (user?.email) {
        this.notificationsService.sendOrderStatusUpdate(user.email, orderId, status, trackingNumber);
      }
    });
  }
}
