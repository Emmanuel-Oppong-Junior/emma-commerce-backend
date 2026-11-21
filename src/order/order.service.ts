import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import {
  assertTransition,
  CUSTOMER_CANCELLABLE,
  DELETABLE_STATUSES,
  FULFILLABLE_STATUSES,
  STAFF_CANCELLABLE,
} from './order-status';
import { CANCELLABLE_SHIPMENT_STATUSES, canShipmentTransition, isDispatch } from './shipment-status';
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
  ShipmentStatus,
} from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { abandonedOrderWhere, OrderSnapshot, OrderSnapshotLine, OrdersRepository } from './order.repository';
import { VariantForSale } from '../cart/cart.repository';
import { notSellableReason } from '../variant/sellable';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { availableOf } from '../inventory/stock';
import { OutboxService } from '../outbox/outbox.service';
import { ShippingZonesService } from '../shipping-zones/shipping-zones.service';
import { PickupLocationsService } from '../pickup-locations/pickup-locations.service';
import { ReturnsService } from '../returns/returns.service';
import { PromotionsService } from '../promotions/promotions.service';
import { CouponNotApplicableError, price, Quote, QuoteAdjustment } from '../pricing/price';
import { StoreService } from '../store/store.service';
import { TaxService } from '../tax/tax.service';
import { assertDeliverableAddress } from '../addresses/deliverable-address';
import { toAddressSnapshot } from '../addresses/address-snapshot';

export const ORDER_EXPIRY_LOCK_KEY = 70_412_001;
/** An unpaid online order, and the stock reserved for it, expires after this long without payment activity. */
export const UNPAID_ORDER_EXPIRY_HOURS = 1;
const ORDER_EXPIRY_MAX_RUN_MS = 10 * 60 * 1000;

/** `extensions.reason` of the CONFLICT createOrder fails with when the cart no longer prices to the client's quote. */
export const QUOTE_CHANGED = 'QUOTE_CHANGED';

export interface CheckoutParams {
  fulfillmentType: FulfillmentType;
  shippingAddressId?: string;
  pickupLocationId?: string;
  couponCode?: string;
}

export interface CreateOrderParams extends CheckoutParams {
  contactEmail: string;
  contactPhone: string;
  paymentMethod?: PaymentMethod;
  /** quoteHash of the checkoutQuote the customer confirmed. */
  quoteHash: string;
}

/** The cart priced for checkout, with each line's cart item and each order adjustment's share per cart item. */
export interface CheckoutQuote extends Omit<Quote, 'lines' | 'adjustments'> {
  lines: (OrderSnapshotLine & { cartItemId: string })[];
  adjustments: (QuoteAdjustment & { allocations: { cartItemId: string; amount: Decimal }[] })[];
}

interface Fulfilment {
  shippingFee: Prisma.Decimal;
  shippingAddressId?: string;
  pickupLocationId?: string;
  shippingAddressSnapshot?: Record<string, unknown>;
  pickupLocationSnapshot?: Record<string, unknown>;
}

interface PricedCheckout {
  cart: Cart & { items: CartItem[] };
  snapshot: OrderSnapshot;
  /** The coupon code entered, when its promotion applied. */
  couponCode?: { id: string; promotionId: string };
  fulfilment: Fulfilment;
}

function quoteChanged(): ConflictException {
  return new ConflictException({
    message: 'The price changed since the quote (prices, promotions, coupon, tax or shipping): get a new checkoutQuote',
    extensions: { reason: QUOTE_CHANGED },
  });
}

/** The promotions the quote takes something off with, at item or cart level. */
function appliedPromotionIds(quote: Pick<Quote, 'lines' | 'adjustments'>): string[] {
  const adjustments = [...quote.lines.flatMap((line) => line.adjustments), ...quote.adjustments];
  return [...new Set(adjustments.map((adjustment) => adjustment.sourceId))];
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly ordersRepository: OrdersRepository,
    private readonly cartService: CartService,
    private readonly auditService: AuditService,
    private readonly stockLedger: StockLedgerService,
    private readonly outbox: OutboxService,
    private readonly shippingZonesService: ShippingZonesService,
    private readonly pickupLocationsService: PickupLocationsService,
    private readonly returnsService: ReturnsService,
    private readonly promotionsService: PromotionsService,
    private readonly storeService: StoreService,
    private readonly taxService: TaxService,
  ) {}

  /**
   * Prices the user's cart for checkout with the given fulfilment and coupon, exactly as createOrder will charge it.
   * Writes nothing.
   */
  async checkoutQuote(userId: string, params: CheckoutParams): Promise<CheckoutQuote> {
    const { cart, snapshot } = await this.priceCheckout(userId, params);
    const cartItemIds = cart.items.map((item) => item.id);
    return {
      ...snapshot,
      lines: snapshot.lines.map((line, index) => ({ ...line, cartItemId: cartItemIds[index] })),
      adjustments: snapshot.adjustments.map(({ allocations, ...adjustment }) => ({
        ...adjustment,
        allocations: allocations.map((amount, index) => ({ cartItemId: cartItemIds[index], amount })),
      })),
    };
  }

  /**
   * Creates an order from the user's cart, in one transaction: the cart, prices, promotions, coupon, tax rates and
   * shipping are read and priced inside it (the cart row and its variants locked), and the order is placed only if
   * that quote's hash is the `quoteHash` the customer confirmed; otherwise CONFLICT with reason QUOTE_CHANGED and
   * nothing is reserved, charged or recorded. The order stores the quote as its snapshot, so it charges the quote's
   * grand total. DELIVERY needs shippingAddressId (shipping fee by city); PICKUP needs pickupLocationId (no fee).
   */
  async createOrderFromCart(userId: string, params: CreateOrderParams): Promise<Order & { items: OrderItem[] }> {
    return this.ordersRepository.runTransaction(async (tx) => {
      const checkout = await this.priceCheckout(userId, params, tx);
      if (checkout.snapshot.quoteHash !== params.quoteHash) throw quoteChanged();
      return this.placeOrder(tx, userId, checkout, params);
    });
  }

  /**
   * Reads everything the price depends on and prices the cart. With `tx` (createOrder), the reads happen in that
   * transaction: the cart row is locked first, so a repeated checkout of the same cart waits and then finds it empty,
   * and the cart's variants are share-locked before their prices are read, so they cannot change until it commits.
   */
  private async priceCheckout(
    userId: string,
    params: CheckoutParams,
    tx?: Prisma.TransactionClient,
  ): Promise<PricedCheckout> {
    if (tx) await this.ordersRepository.lockCart(tx, userId);
    const cart = await this.ensureValidCart(userId, tx);
    await this.ensureUserCanOrder(userId, cart, tx);
    const fulfilment =
      params.fulfillmentType === FulfillmentType.DELIVERY
        ? await this.deliveryTo(userId, params.shippingAddressId, tx)
        : await this.pickupAt(params.pickupLocationId, tx);
    if (tx) await this.ordersRepository.lockVariants(tx, [...new Set(cart.items.map((item) => item.variantId))]);
    const { snapshot, couponCode } = await this.buildOrderDetails(
      cart.items,
      userId,
      fulfilment.shippingFee,
      params.couponCode,
      tx,
    );
    return { cart, snapshot, couponCode, fulfilment };
  }

  private async deliveryTo(
    userId: string,
    shippingAddressId: string | undefined,
    tx?: Prisma.TransactionClient,
  ): Promise<Fulfilment> {
    if (!shippingAddressId) throw new BadRequestException('shippingAddressId is required for DELIVERY orders');
    const address = await this.ensureValidShippingAddress(userId, shippingAddressId, tx);
    assertDeliverableAddress(address);
    return {
      shippingFee: await this.shippingZonesService.getFeeForCity(address.city, tx),
      shippingAddressId,
      shippingAddressSnapshot: toAddressSnapshot(address),
    };
  }

  private async pickupAt(pickupLocationId: string | undefined, tx?: Prisma.TransactionClient): Promise<Fulfilment> {
    if (!pickupLocationId) throw new BadRequestException('pickupLocationId is required for PICKUP orders');
    const location = await this.pickupLocationsService.findActiveById(pickupLocationId, tx);
    return {
      shippingFee: new Prisma.Decimal(0),
      pickupLocationId,
      pickupLocationSnapshot: {
        name: location.name,
        address: location.address,
        city: location.city,
        state: location.state,
        country: location.country,
      },
    };
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

  async getTimeline(orderId: string) {
    return this.ordersRepository.findTimeline(orderId);
  }

  async getShipments(orderId: string) {
    return this.ordersRepository.findShipments(orderId);
  }

  async getPaymentStatus(orderId: string) {
    return this.ordersRepository.findPaymentStatus(orderId);
  }

  /**
   * Retrieves all orders in the system (admin only).
   */
  async getOrders(): Promise<Order[]> {
    return this.ordersRepository.findAll();
  }

  /**
   * Expires PLACED online orders older than the window that have no payment attempt, or only pending, failed or
   * cancelled ones untouched for the window. Returns null when another instance is already running the job.
   */
  async expireAbandonedOrders(expiryHours: number): Promise<number | null> {
    return this.ordersRepository.runWithAdvisoryLock(ORDER_EXPIRY_LOCK_KEY, ORDER_EXPIRY_MAX_RUN_MS, async () => {
      const cutoff = new Date(Date.now() - expiryHours * 60 * 60 * 1000);
      const orders = await this.ordersRepository.findExpiredPendingOrders(cutoff);
      let expired = 0;
      for (const order of orders) {
        try {
          await this.closeOrderAndRestoreStock(order, {
            to: OrderStatus.EXPIRED,
            from: [OrderStatus.PLACED],
            guard: abandonedOrderWhere(cutoff),
            reason: 'Unpaid order expired',
          });
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
   * Moves the order's shipment one step through the fulfilment machine (staff, order.fulfil), creating the shipment on
   * the first step. In the same transaction: the first step moves a CONFIRMED order to IN_FULFILMENT; dispatch
   * (READY_FOR_PICKUP / OUT_FOR_DELIVERY) consumes a cash-on-delivery order's reserved stock (once: only ACTIVE
   * reservations are consumed) and records `shipment.status_changed.v1`; DELIVERED completes the order and records
   * `order.status_changed.v2`. A cash-on-delivery shipment is delivered by recording its cash (recordCodPayment).
   */
  async updateShipmentStatus(
    orderId: string,
    to: ShipmentStatus,
    actorId: string,
    reason?: string,
  ): Promise<Order & { items: OrderItem[] }> {
    return this.ordersRepository.runTransaction(async (tx) => {
      const order = await this.ordersRepository.lockForFulfilment(tx, orderId);
      if (!order || order.deleted) throw new NotFoundException(`Order "${orderId}" not found`);
      if (!FULFILLABLE_STATUSES.includes(order.status)) {
        throw new ConflictException(
          `Order "${orderId}" is ${order.status}; only ${FULFILLABLE_STATUSES.join(' or ')} orders can be fulfilled`,
        );
      }
      if (to === ShipmentStatus.DELIVERED && order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
        throw new BadRequestException(
          `Order "${orderId}" is paid on delivery; record the cash collected (recordCodPayment) to deliver it`,
        );
      }
      const shipment = await this.ordersRepository.findOrCreateShipment(tx, orderId, actorId);
      if (!canShipmentTransition(shipment.status, to, order.fulfillmentType)) {
        throw new ConflictException(
          `Shipment of order "${orderId}" cannot move from ${shipment.status} to ${to} (${order.fulfillmentType})`,
        );
      }
      const moved = await this.ordersRepository.transitionShipment(tx, shipment.id, shipment.status, to, {
        actorId,
        reason,
      });
      if (!moved) throw this.changedMeanwhile(orderId);
      await this.auditService.log(
        {
          entity: 'Shipment',
          entityId: shipment.id,
          action: 'STATUS_CHANGE',
          userId: actorId,
          details: { orderId, from: shipment.status, to, ...(reason && { reason }) },
        },
        tx,
      );

      if (order.status === OrderStatus.CONFIRMED) {
        await this.moveOrder(tx, orderId, OrderStatus.CONFIRMED, OrderStatus.IN_FULFILMENT, actorId, reason);
      }
      if (isDispatch(to)) {
        if (order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
          await this.stockLedger.consumeOrder(tx, orderId, actorId);
        }
        await this.outbox.record(tx, {
          type: 'shipment.status_changed.v1',
          aggregateId: orderId,
          payload: { orderId, shipmentId: shipment.id, status: to, trackingNumber: moved.trackingNumber ?? null },
        });
      }
      if (to === ShipmentStatus.DELIVERED) {
        await this.moveOrder(tx, orderId, OrderStatus.IN_FULFILMENT, OrderStatus.COMPLETED, actorId, reason);
        await this.outbox.record(tx, {
          type: 'order.status_changed.v2',
          aggregateId: orderId,
          payload: { orderId, from: OrderStatus.IN_FULFILMENT, to: OrderStatus.COMPLETED },
        });
      }
      return this.ordersRepository.findForTransaction(tx, orderId);
    });
  }

  /**
   * Cancels an order owned by the requesting user before fulfilment starts, and restores the reserved stock.
   */
  async cancelOrder(userId: string, orderId: string, reason?: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveUserOrder(userId, orderId);
    this.assertCancellable(order, CUSTOMER_CANCELLABLE);
    const cancelled = await this.closeOrderAndRestoreStock(order, {
      to: OrderStatus.CANCELLED,
      from: CUSTOMER_CANCELLABLE,
      actorId: userId,
      reason: reason ?? 'Cancelled by the customer',
    });
    await this.requestReturnIfPaidOnline(order);
    return cancelled;
  }

  /**
   * Cancels any order without an ownership check (staff), and restores the reserved stock. During fulfilment only
   * while the goods are still in the shop (shipment pending, picking, packed or returned).
   */
  async adminCancelOrder(
    orderId: string,
    adminUserId?: string,
    reason?: string,
  ): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveOrder(orderId);
    this.assertCancellable(order, STAFF_CANCELLABLE);
    const cancelled = await this.closeOrderAndRestoreStock(order, {
      to: OrderStatus.CANCELLED,
      from: STAFF_CANCELLABLE,
      guard: { shipments: { every: { status: { in: CANCELLABLE_SHIPMENT_STATUSES } } } },
      actorId: adminUserId,
      reason,
      audit: true,
    });
    await this.requestReturnIfPaidOnline(order);
    return cancelled;
  }

  /**
   * Confirms a placed online order for its owner without a payment. Not exposed by any resolver.
   */
  async markOrderAsPaid(userId: string, orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveUserOrder(userId, orderId);
    if ((order as Order & { paymentMethod: PaymentMethod }).paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
      throw new BadRequestException(`Order "${orderId}" uses cash on delivery and cannot be marked as paid online`);
    }
    assertTransition(orderId, order.status, OrderStatus.CONFIRMED);
    return this.ordersRepository.runTransaction(async (tx) => {
      const paid = await this.ordersRepository.transitionStatus(tx, orderId, OrderStatus.CONFIRMED, [
        OrderStatus.PLACED,
      ]);
      if (!paid) throw this.changedMeanwhile(orderId);
      await this.stockLedger.consumeOrder(tx, orderId, userId);
      return paid;
    });
  }

  /**
   * Soft-deletes a closed (COMPLETED, CANCELLED or EXPIRED) order (admin only). Never moves stock.
   */
  async deleteOrder(orderId: string, adminUserId?: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.retrieveOrder(orderId);
    if (!DELETABLE_STATUSES.includes(order.status)) {
      throw new ConflictException(
        `Order "${orderId}" is ${order.status}; only ${DELETABLE_STATUSES.join(', ')} orders can be deleted (cancel it first)`,
      );
    }
    if (order.deleted) throw new ConflictException(`Order "${orderId}" is already deleted`);
    return this.ordersRepository.runTransaction(async (tx) => {
      const deleted = await this.ordersRepository.softDelete(tx, orderId, DELETABLE_STATUSES);
      if (!deleted) throw this.changedMeanwhile(orderId);
      await this.auditService.log({ entity: 'Order', entityId: orderId, action: 'DELETE', userId: adminUserId }, tx);
      return deleted;
    });
  }

  /**
   * Sets the carrier and tracking number on the order's shipment (created if this is its first fulfilment step) of a
   * confirmed or in-fulfilment order. A tracking number also records `shipment.tracking_updated.v1` in the same
   * transaction, which the worker turns into the customer email.
   */
  async updateShipping(
    orderId: string,
    trackingNumber?: string,
    carrier?: string,
    adminUserId?: string,
  ): Promise<Order & { items: OrderItem[] }> {
    return this.ordersRepository.runTransaction(async (tx) => {
      const order = await this.ordersRepository.lockForFulfilment(tx, orderId);
      if (!order || order.deleted) throw new NotFoundException(`Order "${orderId}" not found`);
      if (!FULFILLABLE_STATUSES.includes(order.status)) {
        throw new ConflictException(
          `Order "${orderId}" is ${order.status}; only ${FULFILLABLE_STATUSES.join(' or ')} orders can be shipped`,
        );
      }
      const shipment = await this.ordersRepository.findOrCreateShipment(tx, orderId, adminUserId);
      await this.ordersRepository.updateShipmentTracking(tx, shipment.id, { trackingNumber, carrier });
      await this.auditService.log(
        {
          entity: 'Shipment',
          entityId: shipment.id,
          action: 'UPDATE',
          userId: adminUserId,
          details: { orderId, trackingNumber, carrier },
        },
        tx,
      );
      if (trackingNumber) {
        await this.outbox.record(tx, {
          type: 'shipment.tracking_updated.v1',
          aggregateId: orderId,
          payload: { orderId, shipmentId: shipment.id, trackingNumber },
        });
      }
      return this.ordersRepository.findForTransaction(tx, orderId);
    });
  }

  private async ensureValidCart(userId: string, tx?: Prisma.TransactionClient): Promise<Cart & { items: CartItem[] }> {
    const cart = await this.cartService.getCartOrThrow(userId, tx);
    if (cart.items.length === 0) throw new NotFoundException(`Cart for user "${userId}" is empty`);
    return cart;
  }

  private async ensureValidShippingAddress(userId: string, shippingAddressId: string, tx?: Prisma.TransactionClient) {
    const address = await this.ordersRepository.findAddressForUser(shippingAddressId, userId, tx);
    if (!address) {
      throw new NotFoundException(`Shipping address "${shippingAddressId}" not found for user "${userId}"`);
    }
    return address;
  }

  private async ensureUserCanOrder(
    userId: string,
    cart: Cart & { items: CartItem[] },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const user = await this.ordersRepository.findUserById(userId, tx);
    if (!user || !user.isActive) throw new BadRequestException(`User "${userId}" is not eligible to place an order`);
    if (cart.items.length > 50) throw new BadRequestException('Order exceeds maximum item limit of 50');
  }

  /**
   * Prices the cart with the pricing engine: item and cart promotions (the coupon code unlocking one), the tax the
   * prices include and shipping. The quote is the order snapshot, so the total charged is the quote's grand total.
   */
  private async buildOrderDetails(
    cartItems: CartItem[],
    userId: string,
    shippingFee: Prisma.Decimal,
    couponCode: string | undefined,
    tx: Prisma.TransactionClient | undefined,
  ): Promise<{ snapshot: OrderSnapshot; couponCode?: { id: string; promotionId: string } }> {
    const now = new Date();
    const currency = await this.storeService.getCurrency(tx);
    const variants: VariantForSale[] = [];
    for (const item of cartItems) variants.push(await this.checkVariantAvailability(item, currency, tx));
    const unique = (ids: (string | null)[]) => [...new Set(ids.filter((id): id is string => id !== null))];
    const promotions = await this.promotionsService.findForPricing(
      {
        variantIds: unique(variants.map((variant) => variant.id)),
        productIds: unique(variants.map((variant) => variant.productId)),
        categoryIds: unique(variants.map((variant) => variant.product.categoryId)),
        brandIds: unique(variants.map((variant) => variant.product.brandId)),
      },
      userId,
      couponCode,
      now,
      tx,
    );
    const taxes = await this.taxService.findActive(tx);

    const quote = this.priceOrThrow(() =>
      price(
        {
          lines: variants.map((variant, index) => ({
            variantId: variant.id,
            productId: variant.productId,
            categoryId: variant.product.categoryId,
            brandId: variant.product.brandId,
            quantity: cartItems[index].quantity,
            unitListPrice: variant.price!,
            taxable: variant.product.isTaxable && variant.basePrice !== null,
          })),
          couponCode: promotions.couponCode,
          shippingFee,
        },
        {
          currency,
          now,
          promotions: promotions.promotions,
          taxRates: taxes.map((tax) => ({ id: tax.id, name: tax.name, rate: tax.rate })),
          customer: promotions.customer,
        },
      ),
    );
    const snapshot: OrderSnapshot = {
      ...quote,
      lines: quote.lines.map((line, index) => ({
        ...line,
        productName: variants[index].product.name,
        sku: variants[index].sku,
        optionValues: variants[index].optionValues,
      })),
    };
    const applied = appliedPromotionIds(quote);
    const code = promotions.couponCode;
    return { snapshot, couponCode: code && applied.includes(code.promotionId) ? code : undefined };
  }

  private priceOrThrow<T>(pricing: () => T): T {
    try {
      return pricing();
    } catch (error) {
      if (error instanceof CouponNotApplicableError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  private async checkVariantAvailability(
    item: CartItem,
    currency: Currency,
    tx: Prisma.TransactionClient | undefined,
  ): Promise<VariantForSale> {
    const variant = await this.ordersRepository.findVariant(item.variantId, tx);
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

  /**
   * Writes the order from the priced checkout, reserves its stock and the uses of the promotions it applies (see
   * PromotionsService.reserveRedemptions), on the caller's tx.
   */
  private async placeOrder(
    tx: Prisma.TransactionClient,
    userId: string,
    checkout: PricedCheckout,
    params: CreateOrderParams,
  ): Promise<Order & { items: OrderItem[] }> {
    const { fulfilment } = checkout;
    const orderDetails = {
      snapshot: checkout.snapshot,
      couponCodeId: checkout.couponCode?.id,
      paymentMethod: params.paymentMethod ?? PaymentMethod.ONLINE,
      contactEmail: params.contactEmail,
      contactPhone: params.contactPhone,
      fulfillmentType: params.fulfillmentType,
      shippingAddressId: fulfilment.shippingAddressId,
      shippingAddressSnapshot: fulfilment.shippingAddressSnapshot,
      pickupLocationId: fulfilment.pickupLocationId,
      pickupLocationSnapshot: fulfilment.pickupLocationSnapshot,
    };
    const cartId = checkout.cart.id;
    const isCod = orderDetails.paymentMethod === PaymentMethod.CASH_ON_DELIVERY;
    const newOrder = await this.ordersRepository.create(tx, userId, orderDetails);

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

    await this.promotionsService.reserveRedemptions(
      tx,
      { orderId: newOrder.id, customerId: userId },
      appliedPromotionIds(checkout.snapshot),
      checkout.couponCode,
    );
    await this.outbox.record(tx, {
      type: 'order.placed.v1',
      aggregateId: newOrder.id,
      payload: { orderId: newOrder.id },
    });

    await this.ordersRepository.clearCartItems(tx, cartId);
    if (!isCod) return newOrder;
    // Cash on delivery needs no payment before fulfilment: it is confirmed as soon as it is placed.
    const confirmed = await this.ordersRepository.transitionStatus(
      tx,
      newOrder.id,
      OrderStatus.CONFIRMED,
      [OrderStatus.PLACED],
      { actorId: userId, reason: 'Cash on delivery accepted' },
    );
    if (!confirmed) throw this.changedMeanwhile(newOrder.id);
    return confirmed;
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
   * Claims the order (conditional status write with its history event, optionally narrowed by `guard`) before
   * releasing its reservations, which are themselves released conditionally, so stock comes back exactly once. The
   * promotion uses are given back and an open payment intent is cancelled in the same transaction.
   */
  private async closeOrderAndRestoreStock(
    order: Order & { items: OrderItem[] },
    close: {
      to: typeof OrderStatus.CANCELLED | typeof OrderStatus.EXPIRED;
      from: readonly OrderStatus[];
      guard?: Prisma.OrderWhereInput;
      actorId?: string;
      reason?: string;
      audit?: boolean;
    },
  ): Promise<Order & { items: OrderItem[] }> {
    return this.ordersRepository.runTransaction(async (tx) => {
      const closed = await this.ordersRepository.transitionStatus(tx, order.id, close.to, close.from, {
        actorId: close.actorId,
        reason: close.reason,
        guard: close.guard,
      });
      if (!closed) throw this.changedMeanwhile(order.id);
      if (close.audit) {
        await this.auditService.log(
          {
            entity: 'Order',
            entityId: order.id,
            action: 'STATUS_CHANGE',
            userId: close.actorId,
            details: { from: order.status, to: close.to, ...(close.reason && { reason: close.reason }) },
          },
          tx,
        );
      }
      await this.promotionsService.releaseRedemptions(tx, order.id);
      await this.stockLedger.releaseOrder(tx, order.id, {
        actorId: close.actorId,
        note: close.to === OrderStatus.EXPIRED ? 'Unpaid order expired' : 'Order cancelled',
      });
      await this.ordersRepository.cancelOpenPaymentIntent(tx, order.id);
      return closed;
    });
  }

  private async moveOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    actorId: string,
    reason?: string,
  ): Promise<void> {
    const moved = await this.ordersRepository.transitionStatus(tx, orderId, to, [from], { actorId, reason });
    if (!moved) throw this.changedMeanwhile(orderId);
    await this.auditService.log(
      {
        entity: 'Order',
        entityId: orderId,
        action: 'STATUS_CHANGE',
        userId: actorId,
        details: { from, to, ...(reason && { reason }) },
      },
      tx,
    );
  }

  private assertCancellable(order: Order, allowed: readonly OrderStatus[]): void {
    if (!allowed.includes(order.status)) {
      throw new ConflictException(
        `Order "${order.id}" is ${order.status}; it can be cancelled only while ${allowed.join(', ')}`,
      );
    }
  }

  private async retrieveOrder(orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.ordersRepository.findById(orderId, { items: true });
    if (!order) throw new NotFoundException(`Order "${orderId}" not found`);
    return order;
  }

  private async requestReturnIfPaidOnline(order: Order & { items: OrderItem[] }): Promise<void> {
    if (order.paymentMethod !== PaymentMethod.ONLINE) return;
    if (!(await this.ordersRepository.hasCapturedPayment(order.id))) return;
    await this.returnsService.createSystemReturnRequest(
      order.id,
      order.userId,
      'Automatic refund request for cancelled paid order',
    );
  }
}
