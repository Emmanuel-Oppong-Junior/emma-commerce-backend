import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CartService } from '../cart/cart.service';
import { Cart, CartItem, Order, OrderItem, OrderStatus, Prisma, Product } from '@prisma/client';
import { AuditService } from '../commons/audit.service';
import { OrdersRepository } from './order.repository';
import { CouponsService } from '../coupons/coupons.service';
import { TaxService } from '../tax/tax.service';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class OrdersService {
  constructor(
    private readonly ordersRepository: OrdersRepository,
    private readonly cartService: CartService,
    private readonly auditService: AuditService,
    private readonly couponsService: CouponsService,
    private readonly taxService: TaxService,
    private readonly inventoryService: InventoryService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Creates a new order from the user's active cart, applies taxes and any coupon, and clears the cart on success.
   * @param userId - The ID of the user placing the order.
   * @param shippingAddressId - The ID of the shipping address to use.
   * @param couponCode - Optional coupon code to apply to the order.
   * @returns The created order with its items.
   * @throws NotFoundException if the cart is empty or the shipping address is not found.
   * @throws BadRequestException if the user is ineligible or stock is insufficient.
   */
  async createOrderFromCart(
    userId: string,
    shippingAddressId: string,
    couponCode?: string,
  ): Promise<Order & { items: OrderItem[] }> {
    const cart = await this.ensureValidCart(userId);
    const address = await this.ensureValidShippingAddress(userId, shippingAddressId);
    await this.ensureUserCanOrder(userId, cart);
    const orderDetails = await this.buildOrderDetails(cart.items, address.country, userId, couponCode);
    const order = await this.saveOrderAndUpdateInventory(userId, shippingAddressId, orderDetails, cart.id, address);
    this.sendOrderConfirmationEmail(userId, order);
    return order;
  }

  /**
   * Retrieves a specific order owned by the given user.
   * @param userId - The ID of the user.
   * @param orderId - The ID of the order.
   * @returns The order with its items.
   * @throws NotFoundException if the order does not exist or does not belong to the user.
   */
  async getOrder(userId: string, orderId: string): Promise<Order & { items: OrderItem[] }> {
    return this.retrieveUserOrder(userId, orderId);
  }

  /**
   * Retrieves an order by ID without any ownership check (admin use).
   * @param orderId - The ID of the order.
   * @returns The order with its items, or null if not found.
   */
  async viewOrder(orderId: string) {
    return this.ordersRepository.findById(orderId, { items: true });
  }

  /**
   * Retrieves all orders placed by a specific user.
   * @param userId - The ID of the user.
   * @returns List of orders with their items.
   */
  async getUserOrders(userId: string): Promise<(Order & { items: OrderItem[] })[]> {
    return this.ordersRepository.findByUser(userId);
  }

  /**
   * Retrieves all orders in the system (admin only).
   * @returns List of all orders.
   */
  async getOrders(): Promise<Order[]> {
    return this.ordersRepository.findAll();
  }

  /**
   * Updates the status of an order and emits shipping notifications when appropriate.
   * @param orderId - The ID of the order to update.
   * @param status - The new order status to apply.
   * @param adminUserId - Optional ID of the admin performing the update (for audit logging).
   * @returns The updated order with its items.
   * @throws NotFoundException if the order does not exist.
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
    return updated;
  }

  /**
   * Cancels an order owned by the user and restores the reserved stock.
   * @param userId - The ID of the user requesting the cancellation.
   * @param orderId - The ID of the order to cancel.
   * @returns The cancelled order with its items.
   * @throws NotFoundException if the order is not found for the user.
   * @throws BadRequestException if the order has already shipped or been delivered.
   */
  async cancelOrder(userId: string, orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveUserOrder(userId, orderId);
    this.ensureOrderCanBeCancelled(order);
    return this.cancelOrderAndRestoreStock(order);
  }

  /**
   * Transitions a pending order to PROCESSING status after confirming the user owns it.
   * @param userId - The ID of the user who owns the order.
   * @param orderId - The ID of the order to mark as paid.
   * @returns The updated order with its items.
   * @throws NotFoundException if the order is not found for the user.
   * @throws BadRequestException if the order is not in PENDING status.
   */
  async markOrderAsPaid(userId: string, orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveUserOrder(userId, orderId);
    this.ensureOrderCanBePaid(order);
    return this.ordersRepository.updateStatus(orderId, 'PROCESSING');
  }

  /**
   * Soft-deletes an order and restores its reserved stock (admin only).
   * @param orderId - The ID of the order to delete.
   * @param adminUserId - Optional ID of the admin performing the deletion (for audit logging).
   * @returns The soft-deleted order with its items.
   * @throws NotFoundException if the order does not exist.
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
   * @param orderId - The ID of the order to update.
   * @param trackingNumber - Optional shipment tracking number.
   * @param carrier - Optional carrier name.
   * @param adminUserId - Optional ID of the admin performing the update (for audit logging).
   * @returns The updated order with its items.
   * @throws NotFoundException if the order does not exist.
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
    country: string,
    userId: string,
    couponCode?: string,
  ): Promise<{
    orderItems: OrderItem[];
    totalAmount: Prisma.Decimal;
    couponId?: string;
    couponDiscount?: number;
  }> {
    const orderItems = await this.createOrderItems(cartItems);
    const subtotal = this.computeSubtotal(orderItems);
    const taxRate = await this.taxService.getRateForCountry(country);
    const tax = subtotal * Number(taxRate);
    const shippingFee = 5.0;

    let couponId: string | undefined;
    let couponDiscount = 0;
    if (couponCode) {
      const { discountAmount, coupon } = await this.couponsService.validateCoupon(couponCode, userId, subtotal);
      couponId = coupon.id;
      couponDiscount = discountAmount;
    }

    const totalAmount = new Prisma.Decimal(Math.max(0, subtotal + tax + shippingFee - couponDiscount).toFixed(2));
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
    shippingAddressId: string,
    orderDetails: {
      orderItems: OrderItem[];
      totalAmount: Prisma.Decimal;
      couponId?: string;
      couponDiscount?: number;
    },
    cartId: string,
    address: { id: string; street: string; city: string; state: string; zipCode: string; country: string },
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

      const shippingAddressSnapshot = {
        street: address.street,
        city: address.city,
        state: address.state,
        zipCode: address.zipCode,
        country: address.country,
      };

      const newOrder = await this.ordersRepository.create(tx, userId, shippingAddressId, {
        ...orderDetails,
        shippingAddressSnapshot,
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
    if (!order || order.userId !== userId) {
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
