import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { allowedFrom, assertTransition, FINAL_STATUSES, isFinal } from './order-status';
import { CartService } from '../cart/cart.service';
import {
  Cart,
  CartItem,
  Currency,
  FulfillmentType,
  Order,
  OrderItem,
  OrderStatus,
  PaymentMethod,
  Prisma,
  Product,
} from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { abandonedOrderWhere, OrdersRepository } from './order.repository';
import { CouponsService } from '../coupons/coupons.service';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ShippingZonesService } from '../shipping-zones/shipping-zones.service';
import { PickupLocationsService } from '../pickup-locations/pickup-locations.service';
import { ReturnsService } from '../returns/returns.service';
import { DiscountService } from '../discount/discount.service';
import { priceCart } from '../discount/pricing';

export const ORDER_EXPIRY_LOCK_KEY = 70_412_001;
const ORDER_EXPIRY_MAX_RUN_MS = 10 * 60 * 1000;

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
    private readonly discountService: DiscountService,
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
    const orderDetails = await this.buildOrderDetails(cart.items, userId, shippingFee, params.couponCode);

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
    const location = await this.pickupLocationsService.findActiveById(params.pickupLocationId);
    const orderDetails = await this.buildOrderDetails(cart.items, userId, new Prisma.Decimal(0), params.couponCode);

    const order = await this.saveOrderAndUpdateInventory(userId, cart.id, {
      ...orderDetails,
      paymentMethod: params.paymentMethod ?? PaymentMethod.ONLINE,
      contactEmail: params.contactEmail,
      contactPhone: params.contactPhone,
      fulfillmentType: FulfillmentType.PICKUP,
      pickupLocationId: params.pickupLocationId,
      pickupLocationSnapshot: {
        name: location.name,
        address: location.address,
        city: location.city,
        state: location.state,
        country: location.country,
      },
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
   * Cancels PENDING online orders older than the window that have no payment attempt, or only pending,
   * failed or abandoned ones untouched for the window. Returns null when another instance is already running the job.
   */
  async expireAbandonedOrders(expiryHours: number): Promise<number | null> {
    return this.ordersRepository.runWithAdvisoryLock(ORDER_EXPIRY_LOCK_KEY, ORDER_EXPIRY_MAX_RUN_MS, async () => {
      const cutoff = new Date(Date.now() - expiryHours * 60 * 60 * 1000);
      const orders = await this.ordersRepository.findExpiredPendingOrders(cutoff);
      let expired = 0;
      for (const order of orders) {
        try {
          await this.cancelOrderAndRestoreStock(order, abandonedOrderWhere(cutoff));
          expired += 1;
        } catch (error) {
          // Paid, payment restarted or cancelled since it was selected: leave it alone and expire the rest.
          if (!(error instanceof ConflictException)) throw error;
        }
      }
      return expired;
    });
  }

  /**
   * Updates the status of an order and emits shipping notifications when appropriate.
   */
  async updateOrderStatus(
    orderId: string,
    status: OrderStatus,
    adminUserId?: string,
  ): Promise<Order & { items: OrderItem[] }> {
    if (status === OrderStatus.CANCELLED) return this.adminCancelOrder(orderId, adminUserId);
    const order = await this.retrieveOrder(orderId);
    assertTransition(orderId, order.status, status);
    if (status === OrderStatus.PROCESSING && order.paymentMethod === PaymentMethod.ONLINE) {
      throw new ConflictException(
        `Order "${orderId}" is awaiting online payment; only a confirmed payment can move it to PROCESSING`,
      );
    }
    const updated = await this.ordersRepository.runTransaction(async (tx) => {
      const transitioned = await this.ordersRepository.transitionStatus(tx, orderId, status, [order.status]);
      if (!transitioned) throw this.changedMeanwhile(orderId);
      await this.auditService.log(
        {
          entity: 'Order',
          entityId: orderId,
          action: 'STATUS_CHANGE',
          userId: adminUserId,
          details: { from: order.status as string, to: status as string },
        },
        tx,
      );
      return transitioned;
    });
    if (status === 'SHIPPED' || status === 'DELIVERED') {
      this.sendOrderStatusEmail(
        order.userId,
        orderId,
        status,
        (updated as Order & { trackingNumber?: string | null }).trackingNumber ?? undefined,
      );
    }
    return updated;
  }

  /**
   * Cancels an order owned by the requesting user and restores the reserved stock.
   */
  async cancelOrder(userId: string, orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveUserOrder(userId, orderId);
    assertTransition(orderId, order.status, OrderStatus.CANCELLED);
    const cancelled = await this.cancelOrderAndRestoreStock(order);
    await this.requestReturnIfPaidOnline(order);
    return cancelled;
  }

  /**
   * Cancels any order without an ownership check (admin only) and restores the reserved stock.
   */
  async adminCancelOrder(orderId: string, adminUserId?: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveOrder(orderId);
    assertTransition(orderId, order.status, OrderStatus.CANCELLED);
    const cancelled = await this.cancelOrderAndRestoreStock(order, undefined, { userId: adminUserId });
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
    assertTransition(orderId, order.status, OrderStatus.PROCESSING);
    const paid = await this.ordersRepository.runTransaction((tx) =>
      this.ordersRepository.transitionStatus(tx, orderId, OrderStatus.PROCESSING, [OrderStatus.PENDING]),
    );
    if (!paid) throw this.changedMeanwhile(orderId);
    return paid;
  }

  /**
   * Soft-deletes a finished (DELIVERED or CANCELLED) order (admin only). Never moves stock.
   */
  async deleteOrder(orderId: string, adminUserId?: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveOrder(orderId);
    if (!isFinal(order.status)) {
      throw new ConflictException(
        `Order "${orderId}" is ${order.status}; only ${FINAL_STATUSES.join(' or ')} orders can be deleted (cancel it first)`,
      );
    }
    if (order.deleted) throw new ConflictException(`Order "${orderId}" is already deleted`);
    return this.ordersRepository.runTransaction(async (tx) => {
      const deleted = await this.ordersRepository.softDelete(tx, orderId, FINAL_STATUSES);
      if (!deleted) throw this.changedMeanwhile(orderId);
      await this.auditService.log({ entity: 'Order', entityId: orderId, action: 'DELETE', userId: adminUserId }, tx);
      return deleted;
    });
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
    const updated = await this.ordersRepository.runTransaction(async (tx) => {
      const shipped = await this.ordersRepository.updateShipping(orderId, trackingNumber, carrier, tx);
      await this.auditService.log(
        {
          entity: 'Order',
          entityId: orderId,
          action: 'UPDATE',
          userId: adminUserId,
          details: { trackingNumber, carrier },
        },
        tx,
      );
      return shipped;
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

  /**
   * Prices the cart with the same function as cartWithDiscount, then takes the coupon off the discounted
   * merchandise subtotal and adds shipping, so the total charged is the total the customer was shown.
   */
  private async buildOrderDetails(
    cartItems: CartItem[],
    userId: string,
    shippingFee: Prisma.Decimal,
    couponCode?: string,
  ): Promise<{
    orderItems: OrderItem[];
    subtotal: Prisma.Decimal;
    discountTotal: Prisma.Decimal;
    shippingFee: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
    couponId?: string;
    couponDiscount?: Prisma.Decimal;
  }> {
    const products: Product[] = [];
    for (const item of cartItems) products.push(await this.checkProductAvailability(item));
    const discounts = await this.discountService.findActiveDiscountsByProduct(products);
    const priced = priceCart(
      cartItems.map((item, index) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: products[index].price as Prisma.Decimal,
      })),
      discounts,
    );

    let couponId: string | undefined;
    let couponDiscount: Prisma.Decimal | undefined;
    if (couponCode) {
      const { discountAmount, coupon } = await this.couponsService.validateCoupon(
        couponCode,
        userId,
        priced.subtotal.toNumber(),
      );
      couponId = coupon.id;
      couponDiscount = new Prisma.Decimal(discountAmount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    }

    const totalAmount = Prisma.Decimal.max(0, priced.subtotal.add(shippingFee).sub(couponDiscount ?? 0));
    return {
      orderItems: priced.lines.map(
        (line) =>
          ({
            productId: line.productId,
            quantity: line.quantity,
            priceAtOrder: line.discountedUnitPrice,
            originalPrice: line.unitPrice,
            discountAmount: line.unitDiscount,
            discountId: line.discountId ?? null,
          }) as OrderItem,
      ),
      subtotal: priced.subtotal,
      discountTotal: priced.discountTotal,
      shippingFee: shippingFee.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      totalAmount: totalAmount.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      couponId,
      couponDiscount: couponDiscount?.isZero() ? undefined : couponDiscount,
    };
  }

  private async checkProductAvailability(item: CartItem): Promise<Product> {
    const product = await this.ordersRepository.findProductById(item.productId);
    if (!product) throw new NotFoundException(`Product "${item.productId}" not found`);
    // Prices are summed and charged as GHS; until multi-currency exists any other currency would be mis-charged.
    if (product.currency !== Currency.GHS) {
      throw new BadRequestException(
        `"${product.name}" is priced in ${product.currency ?? 'no currency'}; only GHS products can be checked out`,
      );
    }
    if (product.price === null) throw new BadRequestException(`"${product.name}" has no price and cannot be sold`);
    if (product.quantity < item.quantity) {
      throw new BadRequestException(
        `Insufficient stock for "${product.name}": ${product.quantity} available, ${item.quantity} requested`,
      );
    }
    return product;
  }

  private async saveOrderAndUpdateInventory(
    userId: string,
    cartId: string,
    orderDetails: {
      orderItems: OrderItem[];
      subtotal: Prisma.Decimal;
      shippingFee: Prisma.Decimal;
      discountTotal: Prisma.Decimal;
      totalAmount: Prisma.Decimal;
      couponId?: string;
      couponDiscount?: Prisma.Decimal;
      paymentMethod?: PaymentMethod;
      contactEmail: string;
      contactPhone: string;
      fulfillmentType: FulfillmentType;
      shippingAddressId?: string;
      pickupLocationId?: string;
      shippingAddressSnapshot?: Record<string, unknown>;
      pickupLocationSnapshot?: Record<string, unknown>;
    },
  ): Promise<Order & { items: OrderItem[] }> {
    return this.ordersRepository.runTransaction(async (tx) => {
      await this.ensureSoldWithoutVariants(
        tx,
        orderDetails.orderItems.map((item) => item.productId),
      );
      for (const item of orderDetails.orderItems) {
        const product = await this.ordersRepository.decrementProductStock(tx, item.productId, item.quantity);
        if (!product) {
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

  /** Checked in the order transaction: the cart may predate the variant, and a variant may be added meanwhile. */
  private async ensureSoldWithoutVariants(tx: Prisma.TransactionClient, productIds: string[]): Promise<void> {
    const names = await this.ordersRepository.findNamesOfProductsWithVariants(tx, productIds);
    if (names.length > 0) {
      throw new BadRequestException(
        `${names.map((name) => `"${name}"`).join(', ')} comes in variants and cannot be bought until variant checkout is available; remove it from the cart`,
      );
    }
  }

  private async retrieveUserOrder(userId: string, orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.ordersRepository.findById(orderId, { items: { include: { product: true } } });
    if (order?.userId !== userId) {
      throw new NotFoundException(`Order "${orderId}" not found`);
    }
    return order;
  }

  private changedMeanwhile(orderId: string): ConflictException {
    return new ConflictException(`Order "${orderId}" was changed by another request; reload it and try again`);
  }

  /**
   * Claims the order (conditional status write, optionally narrowed by `claimGuard`) before returning stock,
   * so stock comes back exactly once.
   */
  private async cancelOrderAndRestoreStock(
    order: Order & { items: OrderItem[] },
    claimGuard?: Prisma.OrderWhereInput,
    auditAs?: { userId?: string },
  ): Promise<Order & { items: OrderItem[] }> {
    return this.ordersRepository.runTransaction(async (tx) => {
      const cancelled = await this.ordersRepository.transitionStatus(
        tx,
        order.id,
        OrderStatus.CANCELLED,
        allowedFrom(OrderStatus.CANCELLED),
        claimGuard,
      );
      if (!cancelled) throw this.changedMeanwhile(order.id);
      if (auditAs) {
        await this.auditService.log(
          {
            entity: 'Order',
            entityId: order.id,
            action: 'STATUS_CHANGE',
            userId: auditAs.userId,
            details: { from: order.status as string, to: OrderStatus.CANCELLED as string },
          },
          tx,
        );
      }
      if (order.couponId) await this.couponsService.releaseUsage(tx, order.id);
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
      return cancelled;
    });
  }

  private async retrieveOrder(orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.ordersRepository.findById(orderId, { items: true });
    if (!order) throw new NotFoundException(`Order "${orderId}" not found`);
    return order;
  }

  private async requestReturnIfPaidOnline(order: Order & { items: OrderItem[] }): Promise<void> {
    if (order.paymentMethod !== PaymentMethod.ONLINE) return;
    if (!(await this.ordersRepository.hasCompletedPayment(order.id))) return;
    await this.returnsService.createSystemReturnRequest(
      order.id,
      order.userId,
      'Automatic refund request for cancelled paid order',
    );
  }

  private readonly emailLogger = new Logger(OrdersService.name);

  private sendOrderConfirmationEmail(userId: string, order: Order): void {
    this.ordersRepository
      .findUserById(userId)
      .then((user) => {
        if (user?.email) {
          this.notificationsService.sendOrderConfirmation(user.email, order.id, Number(order.totalAmount));
        }
      })
      .catch((error: unknown) => this.logEmailFailure('order confirmation', order.id, error));
  }

  private sendOrderStatusEmail(userId: string, orderId: string, status: string, trackingNumber?: string): void {
    this.ordersRepository
      .findUserById(userId)
      .then((user) => {
        if (user?.email) {
          this.notificationsService.sendOrderStatusUpdate(user.email, orderId, status, trackingNumber);
        }
      })
      .catch((error: unknown) => this.logEmailFailure('order status', orderId, error));
  }

  private logEmailFailure(emailKind: string, orderId: string, error: unknown): void {
    this.emailLogger.error(
      `Could not send ${emailKind} email | orderId: ${orderId}`,
      error instanceof Error ? error.message : String(error),
    );
  }
}
