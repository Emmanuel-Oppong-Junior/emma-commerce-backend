import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CartService } from '../cart/cart.service';
import { Cart, CartItem, Order, OrderItem, OrderStatus, Prisma, Product } from '@prisma/client';
import { AuditService } from '../commons/audit.service';
import { OrdersRepository } from './order.repository';

@Injectable()
export class OrdersService {
  constructor(
    private readonly ordersRepository: OrdersRepository,
    private readonly cartService: CartService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Creates an order from the user's cart using the specified shipping address.
   * @param userId - The ID of the user placing the order.
   * @param shippingAddressId - The ID of the shipping address.
   * @returns The created order with its items.
   */
  async createOrderFromCart(userId: string, shippingAddressId: string): Promise<Order & { items: OrderItem[] }> {
    const cart = await this.ensureValidCart(userId);
    await this.ensureValidShippingAddress(userId, shippingAddressId);
    await this.ensureUserCanOrder(userId, cart);
    const orderDetails = await this.buildOrderDetails(cart.items);
    return this.saveOrderAndUpdateInventory(userId, shippingAddressId, orderDetails, cart.id);
  }

  /**
   * Retrieves a specific order by ID for the user.
   * @param userId - The ID of the user.
   * @param orderId - The ID of the order.
   * @returns The order with its items.
   */
  async getOrder(userId: string, orderId: string): Promise<Order & { items: OrderItem[] }> {
    return this.retrieveUserOrder(userId, orderId);
  }

  /**
   * Retrieves a specific order by ID for administrator view purpose.
   * @param orderId - The ID of the order.
   * @returns The order with its items.
   */
  async viewOrder(orderId: string) {
    return this.ordersRepository.findById(orderId, { items: true });
  }

  /**
   * Retrieves all orders for the user.
   * @param userId - The ID of the user.
   * @returns List of orders with their items.
   */
  async getUserOrders(userId: string): Promise<(Order & { items: OrderItem[] })[]> {
    return this.ordersRepository.findByUser(userId);
  }

  /**
   * Retrieves all orders from the database (e.g., for admin use).
   * @returns List of all orders.
   */
  async getOrders(): Promise<Order[]> {
    return this.ordersRepository.findAll();
  }

  /**
   * Updates the status of an order.
   * @param orderId - The ID of the order.
   * @param status - The new status.
   * @returns The updated order with its items.
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
    return updated;
  }

  /**
   * Cancels an order and restores product stock.
   * @param userId - The ID of the user.
   * @param orderId - The ID of the order.
   * @returns The cancelled order with its items.
   */
  async cancelOrder(userId: string, orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveUserOrder(userId, orderId);
    this.ensureOrderCanBeCancelled(order);
    return this.cancelOrderAndRestoreStock(order);
  }

  /**
   * Marks an order as paid, transitioning to PROCESSING status.
   * @param userId - The ID of the user.
   * @param orderId - The ID of the order.
   * @returns The updated order with its items.
   */
  async markOrderAsPaid(userId: string, orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveUserOrder(userId, orderId);
    this.ensureOrderCanBePaid(order);
    return this.ordersRepository.updateStatus(orderId, 'PROCESSING');
  }

  /**
   * Deletes an order and restores stock (admin only).
   * @param orderId - The ID of the order.
   * @returns The deleted order with its items.
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

  private async ensureValidCart(userId: string): Promise<Cart & { items: CartItem[] }> {
    const cart = await this.cartService.getCartOrThrow(userId);
    if (cart.items.length === 0) throw new NotFoundException(`Cart for user "${userId}" is empty`);
    return cart;
  }

  private async ensureValidShippingAddress(userId: string, shippingAddressId: string): Promise<void> {
    const address = await this.ordersRepository.findAddressForUser(shippingAddressId, userId);
    if (!address) {
      throw new NotFoundException(`Shipping address "${shippingAddressId}" not found for user "${userId}"`);
    }
  }

  private async ensureUserCanOrder(userId: string, cart: Cart & { items: CartItem[] }): Promise<void> {
    const user = await this.ordersRepository.findUserById(userId);
    if (!user || !user.isActive) throw new BadRequestException(`User "${userId}" is not eligible to place an order`);
    if (cart.items.length > 50) throw new BadRequestException('Order exceeds maximum item limit of 50');
  }

  private async buildOrderDetails(
    cartItems: CartItem[],
  ): Promise<{ orderItems: OrderItem[]; totalAmount: Prisma.Decimal }> {
    const orderItems = await this.createOrderItems(cartItems);
    const totalAmount = new Prisma.Decimal(this.computeTotalAmount(orderItems).toFixed(2));
    return { orderItems, totalAmount };
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

  private computeTotalAmount(orderItems: OrderItem[]): number {
    const subtotal = orderItems.reduce((sum, item) => sum + Number(item.priceAtOrder) * item.quantity, 0);
    const tax = subtotal * 0.1;
    const shippingFee = 5.0;
    return subtotal + tax + shippingFee;
  }

  private async saveOrderAndUpdateInventory(
    userId: string,
    shippingAddressId: string,
    orderDetails: { orderItems: OrderItem[]; totalAmount: Prisma.Decimal },
    cartId: string,
  ): Promise<Order & { items: OrderItem[] }> {
    return this.ordersRepository.runTransaction(async (tx) => {
      for (const item of orderDetails.orderItems) {
        const product = await this.ordersRepository.decrementProductStock(tx, item.productId, item.quantity);
        if (product.quantity < 0) {
          throw new BadRequestException(`Insufficient stock for product "${item.productId}" — please review your cart`);
        }
      }
      const newOrder = await this.ordersRepository.create(tx, userId, shippingAddressId, orderDetails);
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
        await this.ordersRepository.updateProductStock(tx, item.productId, item.quantity);
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
}
