import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
} from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { abandonedOrderWhere, OrdersRepository } from './order.repository';
import { VariantForSale } from '../cart/cart.repository';
import { notSellableReason } from '../variant/sellable';
import { CouponsService } from '../coupons/coupons.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { availableOf } from '../inventory/stock';
import { OutboxService } from '../outbox/outbox.service';
import { ShippingZonesService } from '../shipping-zones/shipping-zones.service';
import { PickupLocationsService } from '../pickup-locations/pickup-locations.service';
import { ReturnsService } from '../returns/returns.service';
import { DiscountService } from '../discount/discount.service';
import { priceCart } from '../discount/pricing';
import { StoreService } from '../store/store.service';
import { TaxService } from '../tax/tax.service';
import { OrderSnapshot, snapshotOrder } from './order-totals';
import { assertDeliverableAddress } from '../addresses/deliverable-address';
import { toAddressSnapshot } from '../addresses/address-snapshot';

export const ORDER_EXPIRY_LOCK_KEY = 70_412_001;
/** An unpaid online order, and the stock reserved for it, expires after this long without payment activity. */
export const UNPAID_ORDER_EXPIRY_HOURS = 1;
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
    private readonly stockLedger: StockLedgerService,
    private readonly outbox: OutboxService,
    private readonly shippingZonesService: ShippingZonesService,
    private readonly pickupLocationsService: PickupLocationsService,
    private readonly returnsService: ReturnsService,
    private readonly discountService: DiscountService,
    private readonly storeService: StoreService,
    private readonly taxService: TaxService,
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
    assertDeliverableAddress(address);
    const shippingFee = await this.shippingZonesService.getFeeForCity(address.city);
    const orderDetails = await this.buildOrderDetails(cart.items, userId, shippingFee, params.couponCode);

    const order = await this.saveOrderAndUpdateInventory(userId, cart.id, {
      ...orderDetails,
      paymentMethod: params.paymentMethod ?? PaymentMethod.ONLINE,
      contactEmail: params.contactEmail,
      contactPhone: params.contactPhone,
      fulfillmentType: FulfillmentType.DELIVERY,
      shippingAddressId: params.shippingAddressId,
      shippingAddressSnapshot: toAddressSnapshot(address),
    });
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
    return this.ordersRepository.findById(orderId);
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
   * Updates the status of an order. SHIPPED and DELIVERED also record `order.status_changed.v1` in the same
   * transaction, which the worker turns into the customer email.
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
      // Dispatch is the sale for cash on delivery; an online order's reservations were consumed at payment.
      if (status === OrderStatus.SHIPPED) await this.stockLedger.consumeOrder(tx, orderId, adminUserId);
      if (status === OrderStatus.SHIPPED || status === OrderStatus.DELIVERED) {
        await this.outbox.record(tx, {
          type: 'order.status_changed.v1',
          aggregateId: orderId,
          payload: { orderId, status, trackingNumber: transitioned.trackingNumber ?? null },
        });
      }
      return transitioned;
    });
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
    return this.ordersRepository.runTransaction(async (tx) => {
      const paid = await this.ordersRepository.transitionStatus(tx, orderId, OrderStatus.PROCESSING, [
        OrderStatus.PENDING,
      ]);
      if (!paid) throw this.changedMeanwhile(orderId);
      await this.stockLedger.consumeOrder(tx, orderId, userId);
      return paid;
    });
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
   * Updates the shipping carrier and tracking number for an order. A tracking number also records
   * `order.shipment_updated.v1` in the same transaction, which the worker turns into the customer email.
   */
  async updateShipping(
    orderId: string,
    trackingNumber?: string,
    carrier?: string,
    adminUserId?: string,
  ): Promise<Order & { items: OrderItem[] }> {
    await this.retrieveOrder(orderId);
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
      if (trackingNumber) {
        await this.outbox.record(tx, {
          type: 'order.shipment_updated.v1',
          aggregateId: orderId,
          payload: { orderId, trackingNumber },
        });
      }
      return shipped;
    });
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
   * merchandise subtotal and adds shipping, so the total charged is the total the customer was shown. The result is
   * snapshotted with the tax the prices include (taxable variants with a basePrice) and the discounts as adjustments.
   */
  private async buildOrderDetails(
    cartItems: CartItem[],
    userId: string,
    shippingFee: Prisma.Decimal,
    couponCode?: string,
  ): Promise<{ snapshot: OrderSnapshot; couponId?: string }> {
    const currency = await this.storeService.getCurrency();
    const variants: VariantForSale[] = [];
    for (const item of cartItems) variants.push(await this.checkVariantAvailability(item, currency));
    const discounts = await this.discountService.findActiveDiscountsByVariant(
      variants.map((variant) => ({
        id: variant.id,
        productId: variant.productId,
        categoryId: variant.product.categoryId,
        discountId: variant.discountId,
      })),
    );
    const priced = priceCart(
      variants.map((variant, index) => ({
        variantId: variant.id,
        productId: variant.productId,
        quantity: cartItems[index].quantity,
        unitPrice: variant.price!,
      })),
      discounts,
    );

    let coupon: { couponId: string; code: string; amount: Prisma.Decimal } | undefined;
    if (couponCode) {
      const validated = await this.couponsService.validateCoupon(couponCode, userId, priced.subtotal);
      coupon = { couponId: validated.coupon.id, code: validated.coupon.code, amount: validated.discountAmount };
    }

    const taxes = await this.taxService.findActive();
    const snapshot = snapshotOrder({
      currency,
      lines: priced.lines.map((line, index) => ({
        productId: line.productId,
        variantId: line.variantId,
        productName: variants[index].product.name,
        sku: variants[index].sku,
        optionValues: variants[index].optionValues,
        quantity: line.quantity,
        unitListPrice: line.unitPrice,
        unitDiscount: line.unitDiscount,
        discountId: line.discountId,
        taxable: variants[index].product.isTaxable && variants[index].basePrice !== null,
      })),
      taxes: taxes.map((tax) => ({ taxId: tax.id, name: tax.name, rate: tax.rate })),
      shipping: shippingFee,
      coupon,
    });
    return { snapshot, couponId: coupon?.couponId };
  }

  private async checkVariantAvailability(item: CartItem, currency: Currency): Promise<VariantForSale> {
    const variant = await this.ordersRepository.findVariant(item.variantId);
    if (!variant) throw new NotFoundException(`Variant "${item.variantId}" not found`);
    const reason = notSellableReason(variant);
    if (reason) throw new BadRequestException(`${reason}; remove it from the cart`);
    // Prices are summed and charged in the store currency; a product priced in another one would be mis-charged.
    if (variant.product.currency !== currency) {
      throw new BadRequestException(
        `"${variant.product.name}" is priced in ${variant.product.currency ?? 'no currency'}; only ${currency} products can be checked out`,
      );
    }
    const available = availableOf(variant.stockLevels);
    if (available < item.quantity) {
      throw new BadRequestException(
        `Insufficient stock for "${variant.product.name}" (${variant.sku}): ${available} available, ${item.quantity} requested`,
      );
    }
    return variant;
  }

  private async saveOrderAndUpdateInventory(
    userId: string,
    cartId: string,
    orderDetails: {
      snapshot: OrderSnapshot;
      couponId?: string;
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
      const isCod = orderDetails.paymentMethod === PaymentMethod.CASH_ON_DELIVERY;
      const newOrder = await this.ordersRepository.create(tx, userId, {
        ...orderDetails,
        initialStatus: isCod ? OrderStatus.PROCESSING : OrderStatus.PENDING,
      });

      // Cash on delivery holds its stock until dispatch; an online order's hold expires with the unpaid order.
      const expiresAt = isCod ? null : new Date(Date.now() + UNPAID_ORDER_EXPIRY_HOURS * 60 * 60 * 1000);
      for (const item of newOrder.items) {
        const reserved =
          (await this.ordersRepository.lockSellableVariant(tx, item.variantId)) &&
          (await this.stockLedger.reserve(
            tx,
            {
              variantId: item.variantId,
              quantity: item.quantity,
              orderId: newOrder.id,
              orderItemId: item.id,
              expiresAt,
            },
            userId,
          ));
        if (!reserved) {
          throw new BadRequestException(
            `Variant "${item.sku}" is out of stock or no longer on sale — please review your cart`,
          );
        }
      }

      if (orderDetails.couponId) {
        await this.couponsService.recordUsage(tx, orderDetails.couponId, userId, newOrder.id);
      }
      await this.outbox.record(tx, {
        type: 'order.placed.v1',
        aggregateId: newOrder.id,
        payload: { orderId: newOrder.id },
      });

      await this.ordersRepository.clearCartItems(tx, cartId);
      return newOrder;
    });
  }

  private async retrieveUserOrder(userId: string, orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.ordersRepository.findById(orderId);
    if (order?.userId !== userId) {
      throw new NotFoundException(`Order "${orderId}" not found`);
    }
    return order;
  }

  private changedMeanwhile(orderId: string): ConflictException {
    return new ConflictException(`Order "${orderId}" was changed by another request; reload it and try again`);
  }

  /**
   * Claims the order (conditional status write, optionally narrowed by `claimGuard`) before releasing its
   * reservations, which are themselves released conditionally, so stock comes back exactly once.
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
      await this.stockLedger.releaseOrder(tx, order.id, {
        // The expiry job acts for nobody; a cancel without an admin is the customer's own.
        actorId: claimGuard ? undefined : (auditAs?.userId ?? order.userId),
        note: claimGuard ? 'Unpaid order expired' : 'Order cancelled',
      });
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
}
