import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { assertTransition, CUSTOMER_CANCELLABLE, DELETABLE_STATUSES, STAFF_CANCELLABLE } from './order-status';
import { CANCELLABLE_SHIPMENT_STATUSES } from './shipment-status';
import { CartService } from '../cart/cart.service';
import {
  Cart,
  CartItem,
  Currency,
  FulfillmentType,
  Order,
  OrderItem,
  OrderStatus,
  DeliveryServiceLevel,
  PaymentMethod,
  Prisma,
} from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { abandonedOrderWhere, OrderSnapshot, OrderSnapshotLine, OrdersRepository } from './order.repository';
import { VariantForSale } from '../cart/cart.repository';
import { notSellableReason } from '../variant/sellable';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { chooseFulfilmentLocation, sellableQuantity } from '../inventory/fulfilment-location';
import { StockLocationsService } from '../inventory/locations/stock-locations.service';
import { OutboxService } from '../outbox/outbox.service';
import { DeliveryZone, ShippingZonesService } from '../shipping-zones/shipping-zones.service';
import { DELIVERY_LEVEL_UNAVAILABLE, deliveryFee, DeliveryFee, offeredLevels } from '../shipping-zones/delivery-fee';
import { LoggerService } from '../commons/logger.service';
import { formatOpeningHours } from '../pickup-locations/opening-hours';
import { DeliverySlotsService, toAvailableDeliverySlot } from '../shipping-zones/slots/delivery-slots.service';
import { AvailableDeliverySlot } from '../shipping-zones/slots/delivery-slots.types';
import {
  AvailableSlot,
  bookableSlot,
  DELIVERY_SLOT_REQUIRED,
  DELIVERY_SLOT_UNAVAILABLE,
  SLOT_FULL,
  upcomingSlots,
} from '../shipping-zones/slots/delivery-slots';
import { PickupLocationsService } from '../pickup-locations/pickup-locations.service';
import { RefundsService } from '../returns/refunds.service';
import { PromotionsService } from '../promotions/promotions.service';
import { PriceListsService } from '../price-lists/price-lists.service';
import { CouponNotApplicableError, price, Quote, QuoteAdjustment } from '../pricing/price';
import { StoreService } from '../store/store.service';
import { TaxService } from '../tax/tax.service';
import { assertDeliverableAddress } from '../addresses/deliverable-address';
import { EnteredAddress, toAddressSnapshot, toEnteredAddressSnapshot } from '../addresses/address-snapshot';
import { PaymentSettingsService } from '../payment/settings/payment-settings.service';
import { VelocityService } from '../fraud/velocity.service';
import { VelocityCheckpoint, VelocityEvent, velocitySubjects } from '../fraud/velocity-rules';
import { CodAvailability, CodRiskService } from '../cod/cod-risk.service';
import { CodUnavailableReason } from '../cod/cod-risk';
import {
  assertGuestPaymentMethod,
  assertGuestPhoneVerified,
  guestPricingFacts,
} from '../guest-checkout/guest-checkout-rules';
import { DeliveryAddressFacts } from '../cod/cod-blacklist';
import { ExpiredLotUnits, sellableLevels } from '../inventory/lots/lots';
import { SerialUnitsService } from '../inventory/serials/serial-units.service';
import { LOYALTY_BALANCE_CHANGED, LoyaltyLedger } from '../loyalty/loyalty-ledger.service';
import { PointsNotRedeemableError, PointsRefusal, PricingLoyalty } from '../pricing/points-redemption';
import { featureDisabled } from '../store-features/require-feature';

export const ORDER_EXPIRY_LOCK_KEY = 70_412_001;
/** An unpaid online order, and the stock reserved for it, expires after this long without payment activity. */
export const UNPAID_ORDER_EXPIRY_HOURS = 1;
const ORDER_EXPIRY_MAX_RUN_MS = 10 * 60 * 1000;

/** `extensions.reason` of the CONFLICT createOrder fails with when the cart no longer prices to the client's quote. */
export const QUOTE_CHANGED = 'QUOTE_CHANGED';

/** Who checks out: a signed-in customer, or a guest cart (P6-G.1) whose verified phone places the order. */
export type Buyer = { userId: string } | { guestCartId: string };

export interface CheckoutParams {
  fulfillmentType: FulfillmentType;
  /** A customer's DELIVERY: one of their saved addresses. */
  shippingAddressId?: string;
  /** A guest's DELIVERY: the address itself, copied onto the order. */
  shippingAddress?: EnteredAddress;
  pickupLocationId?: string;
  couponCode?: string;
  /** Defaults to ONLINE; refused when the store does not offer it. */
  paymentMethod?: PaymentMethod;
  /** DELIVERY only; defaults to STANDARD. Refused when the address's zone does not offer it. */
  serviceLevel?: DeliveryServiceLevel;
  /** STANDARD delivery to a zone with slots: the slot booked (one of checkoutQuote.deliverySlots). */
  deliverySlot?: { slotId: string; date: string };
  /** Customers only (P6-L.1): loyalty points to redeem; refused with BAD_REQUEST and a PointsRefusal reason. */
  redeemPoints?: number;
}

export interface CreateOrderParams extends CheckoutParams {
  /** Required for customers; optional for guests (receipts by email only when given). */
  contactEmail: string | null;
  /** A guest's: the verified phone of the cart, checked again in the order transaction. */
  contactPhone: string;
  /** Guests only: who the order is for. */
  contactName?: string;
  /** quoteHash of the checkoutQuote the customer confirmed. */
  quoteHash: string;
  /** The client's IP address, for velocity checks. */
  clientIp?: string;
}

/** The cart priced for checkout, with each line's cart item and each order adjustment's share per cart item. */
export interface CheckoutQuote extends Omit<Quote, 'lines' | 'adjustments' | 'delivery'> {
  lines: (OrderSnapshotLine & { cartItemId: string; fromPriceList: boolean })[];
  adjustments: (QuoteAdjustment & { allocations: { cartItemId: string; amount: Decimal }[] })[];
  /** Whether this checkout could be paid on delivery (P3-B), whatever payment method was asked for. */
  cashOnDelivery: CodAvailability;
  /** DELIVERY: the zone, rule and fee priced, with the booked slot's window; null for pickup. */
  delivery: (Omit<DeliveryQuote, 'slot'> & { slot: AvailableDeliverySlot | null }) | null;
  /** DELIVERY: every service level the zone offers with its fee for this cart; empty for pickup. */
  deliveryOptions: DeliveryFee[];
  /** STANDARD delivery: the zone's slots of the next days (full ones with 0 remaining); empty otherwise. */
  deliverySlots: AvailableDeliverySlot[];
  /** createOrder needs a deliverySlot: STANDARD delivery to a zone with active slots. */
  deliverySlotRequired: boolean;
  /** A customer's loyalty points for this checkout (P6-L.1); null for a guest. */
  loyalty: CheckoutLoyalty | null;
}

export interface CheckoutLoyalty {
  balance: number;
  redeemablePoints: number;
  pointsRedeemed: number;
  /** What the points redeemed take off (positive; 0 when none). */
  amount: Decimal;
}

export interface DeliveryQuote extends DeliveryFee {
  /** The slot booked; null when none was chosen (or the zone or level has none). */
  slot: AvailableSlot | null;
  zoneId: string;
  zoneName: string;
  /** Sum of variant weight x quantity; a variant without a weight counts 0 g. */
  weightGrams: number;
}

interface Fulfilment {
  /** The delivery zone and its rate rules; null for pickup. */
  zone: DeliveryZone | null;
  /** The delivery zone; null for pickup. */
  shippingZoneId: string | null;
  /** The delivery address the cash-on-delivery blacklist is matched against; null for pickup. */
  deliveryAddress: DeliveryAddressFacts | null;
  shippingAddressId?: string;
  pickupLocationId?: string;
  shippingAddressSnapshot?: Record<string, unknown>;
  pickupLocationSnapshot?: Record<string, unknown>;
  /** The stock locations that may fulfil the order, in the order they are tried. */
  fulfilmentLocationIds: string[];
}

interface PricedCheckout {
  cart: Cart & { items: CartItem[] };
  buyer: Buyer;
  snapshot: OrderSnapshot;
  delivery: { quote: DeliveryQuote; options: DeliveryFee[]; slots: AvailableSlot[]; slotRequired: boolean } | null;
  /** The coupon code entered, when its promotion applied. */
  couponCode?: { id: string; promotionId: string };
  fulfilment: Fulfilment;
  /** The customer's points as priced; null for a guest. */
  loyalty: PricingLoyalty | null;
}

function quoteChanged(): ConflictException {
  return new ConflictException({
    message: 'The price changed since the quote (prices, promotions, coupon, tax or shipping): get a new checkoutQuote',
    extensions: { reason: QUOTE_CHANGED },
  });
}

/** The promotions the quote takes something off with, at item, cart or shipping level. */
function appliedPromotionIds(quote: Pick<Quote, 'lines' | 'adjustments' | 'shippingAdjustments'>): string[] {
  const adjustments = [
    ...quote.lines.flatMap((line) => line.adjustments),
    ...quote.adjustments,
    ...quote.shippingAdjustments,
  ];
  return [...new Set(adjustments.map((adjustment) => adjustment.sourceId))];
}

/** Each cart item's share of an order adjustment: the shares of its quote lines (a split cart line has several). */
function sharesByCartItem(allocations: Decimal[], cartItemIds: string[]): { cartItemId: string; amount: Decimal }[] {
  const byCartItem = new Map<string, Decimal>();
  allocations.forEach((amount, index) =>
    byCartItem.set(cartItemIds[index], (byCartItem.get(cartItemIds[index]) ?? new Decimal(0)).add(amount)),
  );
  return [...byCartItem].map(([cartItemId, amount]) => ({ cartItemId, amount }));
}

/** The units each item promotion reduced, by promotion id (a quote line's adjustments apply to all its units). */
function discountedUnits(quote: Pick<Quote, 'lines'>): Record<string, number> {
  const units: Record<string, number> = {};
  for (const line of quote.lines) {
    for (const { sourceId } of line.adjustments) units[sourceId] = (units[sourceId] ?? 0) + line.quantity;
  }
  return units;
}

function slotUnavailable(message: string): BadRequestException {
  return new BadRequestException({ message, extensions: { reason: DELIVERY_SLOT_UNAVAILABLE } });
}

function outOfStock(sku: string | null): BadRequestException {
  return new BadRequestException(`Variant "${sku}" is out of stock or no longer on sale — please review your cart`);
}

function notAllAtOneLocation(): BadRequestException {
  return new BadRequestException(
    'The items in your cart are not all in stock at one location that serves this delivery — please review your cart',
  );
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
    private readonly refunds: RefundsService,
    private readonly promotionsService: PromotionsService,
    private readonly priceListsService: PriceListsService,
    private readonly storeService: StoreService,
    private readonly taxService: TaxService,
    private readonly paymentSettings: PaymentSettingsService,
    private readonly velocity: VelocityService,
    private readonly codRisk: CodRiskService,
    private readonly stockLocations: StockLocationsService,
    private readonly serialUnits: SerialUnitsService,
    private readonly logger: LoggerService,
    private readonly deliverySlots: DeliverySlotsService,
    private readonly loyalty: LoyaltyLedger,
  ) {}

  /**
   * Prices the user's cart for checkout with the given fulfilment and coupon, exactly as createOrder will charge it.
   * Writes nothing. BAD_REQUEST with reason PAYMENT_METHOD_UNAVAILABLE when the store does not offer the payment method.
   * Reports whether the checkout could be paid on delivery (`cashOnDelivery`) without refusing it.
   */
  async checkoutQuote(userId: string, params: CheckoutParams): Promise<CheckoutQuote> {
    return this.quoteFor({ userId }, params);
  }

  /**
   * checkoutQuote for a guest cart (P6-G.1): the same engine and quoteHash, priced as a visitor (no customer-group,
   * first-order or per-customer-limit promotions, no price lists). Cash on delivery is refused (BAD_REQUEST, reason
   * COD_NOT_AVAILABLE with codReason GUEST_CHECKOUT).
   */
  async guestCheckoutQuote(guestCartId: string, params: CheckoutParams): Promise<CheckoutQuote> {
    return this.quoteFor({ guestCartId }, params);
  }

  private async quoteFor(buyer: Buyer, params: CheckoutParams): Promise<CheckoutQuote> {
    if ('guestCartId' in buyer) assertGuestPaymentMethod(params.paymentMethod);
    await this.paymentSettings.assertOrderPaymentMethod(params.paymentMethod ?? PaymentMethod.ONLINE);
    const { cart, snapshot, fulfilment, delivery, loyalty } = await this.priceCheckout(buyer, params);
    const cashOnDelivery: CodAvailability =
      'userId' in buyer
        ? await this.codRisk.availability(buyer.userId, {
            grandTotal: snapshot.grandTotal,
            shippingZoneId: fulfilment.shippingZoneId,
            address: fulfilment.deliveryAddress,
          })
        : {
            available: false,
            reason: CodUnavailableReason.GUEST_CHECKOUT,
            phoneVerified: cart.guestPhoneVerifiedAt !== null,
          };
    const cartItemIds = snapshot.lines.map((line) => cart.items[line.cartLineIndex].id);
    return {
      ...snapshot,
      lines: snapshot.lines.map((line, index) => ({
        ...line,
        cartItemId: cartItemIds[index],
        fromPriceList: line.priceList !== null,
      })),
      adjustments: snapshot.adjustments.map(({ allocations, ...adjustment }) => ({
        ...adjustment,
        allocations: sharesByCartItem(allocations, cartItemIds),
      })),
      cashOnDelivery,
      delivery: delivery && {
        ...delivery.quote,
        slot: delivery.quote.slot && toAvailableDeliverySlot(delivery.quote.slot),
      },
      deliveryOptions: delivery?.options ?? [],
      deliverySlots: (delivery?.slots ?? []).map(toAvailableDeliverySlot),
      deliverySlotRequired: delivery?.slotRequired ?? false,
      loyalty: loyalty && {
        balance: loyalty.balance,
        redeemablePoints: snapshot.redeemablePoints,
        pointsRedeemed: snapshot.loyaltyRedemption?.points ?? 0,
        amount: snapshot.loyaltyRedemption?.amount.neg() ?? new Decimal(0),
      },
    };
  }

  /**
   * Creates an order from the user's cart, in one transaction: the cart, prices, promotions, coupon, tax rates and
   * shipping are read and priced inside it (the cart row and its variants locked), and the order is placed only if
   * that quote's hash is the `quoteHash` the customer confirmed; otherwise CONFLICT with reason QUOTE_CHANGED and
   * nothing is reserved, charged or recorded. The order stores the quote as its snapshot, so it charges the quote's
   * grand total. DELIVERY needs shippingAddressId (fee from the address's zone and the service level); PICKUP needs
   * pickupLocationId (no fee). A
   * payment method the store does not offer is refused first (BAD_REQUEST, reason PAYMENT_METHOD_UNAVAILABLE). Cash on
   * delivery also has to pass the risk gates (CodRiskService.assertCodAllowed: PHONE_NOT_VERIFIED, COD_NOT_AVAILABLE).
   */
  async createOrderFromCart(userId: string, params: CreateOrderParams): Promise<Order & { items: OrderItem[] }> {
    return this.placeFor({ userId }, params);
  }

  /**
   * createOrder for a guest cart (P6-G.1): the cart's phone must be verified and still be `contactPhone` when the
   * cart is locked in the order transaction (BAD_REQUEST, reason GUEST_PHONE_NOT_VERIFIED); paid online only. The
   * order has no account: it keeps the verified phone, the name and the optional email, and attaches to the account
   * that later verifies that phone. Velocity is screened per phone and network.
   */
  async createGuestOrder(guestCartId: string, params: CreateOrderParams): Promise<Order & { items: OrderItem[] }> {
    return this.placeFor({ guestCartId }, params);
  }

  private async placeFor(buyer: Buyer, params: CreateOrderParams): Promise<Order & { items: OrderItem[] }> {
    if ('guestCartId' in buyer) assertGuestPaymentMethod(params.paymentMethod);
    await this.paymentSettings.assertOrderPaymentMethod(params.paymentMethod ?? PaymentMethod.ONLINE);
    const userId = 'userId' in buyer ? buyer.userId : null;
    const subjects = velocitySubjects({
      customerId: userId ?? undefined,
      phone: params.contactPhone,
      ip: params.clientIp,
    });
    const softHits = await this.velocity.screenOrRefuse(VelocityCheckpoint.ORDER_PLACEMENT, subjects);
    const order = await this.ordersRepository.runTransaction(async (tx) => {
      const checkout = await this.priceCheckout(buyer, params, tx);
      if ('guestCartId' in buyer) assertGuestPhoneVerified(checkout.cart, params.contactPhone);
      if (checkout.delivery?.slotRequired && !checkout.delivery.quote.slot) {
        throw new BadRequestException({
          message: 'Choose a delivery slot (checkoutQuote.deliverySlots) for STANDARD delivery to this address',
          extensions: { reason: DELIVERY_SLOT_REQUIRED },
        });
      }
      if (checkout.snapshot.quoteHash !== params.quoteHash) throw quoteChanged();
      const codPhone =
        userId && params.paymentMethod === PaymentMethod.CASH_ON_DELIVERY
          ? await this.codRisk.assertCodAllowed(tx, userId, {
              grandTotal: checkout.snapshot.grandTotal,
              shippingZoneId: checkout.fulfilment.shippingZoneId,
              address: checkout.fulfilment.deliveryAddress,
              contactPhone: params.contactPhone,
            })
          : undefined;
      const placed = await this.placeOrder(tx, checkout, params, codPhone);
      await this.velocity.flagOrder(placed.id, softHits, tx);
      return placed;
    });
    await this.velocity.record(VelocityEvent.ORDER_PLACED, subjects);
    return order;
  }

  /**
   * Reads everything the price depends on and prices the cart. With `tx` (createOrder), the reads happen in that
   * transaction: the cart row is locked first, so a repeated checkout of the same cart waits and then finds it empty,
   * and the cart's variants are share-locked before their prices are read, so they cannot change until it commits.
   */
  private async priceCheckout(
    buyer: Buyer,
    params: CheckoutParams,
    tx?: Prisma.TransactionClient,
  ): Promise<PricedCheckout> {
    if (tx) {
      await ('userId' in buyer
        ? this.ordersRepository.lockCart(tx, buyer.userId)
        : this.ordersRepository.lockGuestCart(tx, buyer.guestCartId));
    }
    const cart = await this.ensureValidCart(buyer, tx);
    if ('userId' in buyer) await this.ensureUserCanOrder(buyer.userId, tx);
    if (cart.items.length > 50) throw new BadRequestException('Order exceeds maximum item limit of 50');
    const fulfilment =
      params.fulfillmentType === FulfillmentType.DELIVERY
        ? await this.deliveryTo(buyer, params, tx)
        : await this.pickupAt(params.pickupLocationId, tx);
    if (tx) await this.ordersRepository.lockVariants(tx, [...new Set(cart.items.map((item) => item.variantId))]);
    const { snapshot, couponCode, delivery, loyalty } = await this.buildOrderDetails(
      cart.items,
      buyer,
      fulfilment,
      params,
      tx,
    );
    return { cart, buyer, snapshot, couponCode, fulfilment, delivery, loyalty };
  }

  private async deliveryTo(
    buyer: Buyer,
    params: Pick<CheckoutParams, 'shippingAddressId' | 'shippingAddress'>,
    tx?: Prisma.TransactionClient,
  ): Promise<Fulfilment> {
    if ('guestCartId' in buyer) {
      const entered = params.shippingAddress;
      if (!entered) throw new BadRequestException('shippingAddress is required for DELIVERY orders');
      const zone = await this.shippingZonesService.deliveryZoneFor(
        { country: entered.country, region: entered.region, city: entered.city, area: entered.area ?? null },
        tx,
      );
      return {
        zone,
        shippingZoneId: zone.id,
        fulfilmentLocationIds: await this.stockLocations.candidatesFor({ shippingZoneId: zone.id }, tx),
        deliveryAddress: entered,
        shippingAddressSnapshot: toEnteredAddressSnapshot(entered),
      };
    }
    const { shippingAddressId } = params;
    if (!shippingAddressId) throw new BadRequestException('shippingAddressId is required for DELIVERY orders');
    const address = await this.ensureValidShippingAddress(buyer.userId, shippingAddressId, tx);
    assertDeliverableAddress(address);
    const zone = await this.shippingZonesService.deliveryZoneFor(address, tx);
    return {
      zone,
      shippingZoneId: zone.id,
      fulfilmentLocationIds: await this.stockLocations.candidatesFor({ shippingZoneId: zone.id }, tx),
      deliveryAddress: address,
      shippingAddressId,
      shippingAddressSnapshot: toAddressSnapshot(address),
    };
  }

  private async pickupAt(pickupLocationId: string | undefined, tx?: Prisma.TransactionClient): Promise<Fulfilment> {
    if (!pickupLocationId) throw new BadRequestException('pickupLocationId is required for PICKUP orders');
    const location = await this.pickupLocationsService.findActiveById(pickupLocationId, tx);
    return {
      zone: null,
      shippingZoneId: null,
      deliveryAddress: null,
      fulfilmentLocationIds: await this.stockLocations.candidatesFor({ pickupLocationId }, tx),
      pickupLocationId,
      pickupLocationSnapshot: {
        name: location.name,
        address: location.address,
        city: location.city,
        region: location.region,
        country: location.country,
        contactPhone: location.contactPhone,
        instructions: location.instructions,
        openingHours: formatOpeningHours(location.openingHours),
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
  async getOrders(filter: { status?: OrderStatus }, first: number, after?: string): Promise<Order[]> {
    return this.ordersRepository.findPage(filter, { take: first, after });
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
   * Cancels an order owned by the requesting user before fulfilment starts, and restores the reserved stock. A paid
   * online order gets a PENDING refund of its payment for staff to send.
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
    return cancelled;
  }

  /**
   * Cancels any order without an ownership check (staff), and restores the reserved stock. During fulfilment only
   * while no shipment has left the shop (every shipment pending, picking, packed, returned or cancelled): after a
   * partial dispatch staff cancel the remaining shipments and refund what will not ship instead. Shipments not yet
   * dispatched are cancelled with the order. A paid online order gets a PENDING refund of its payment for staff to send.
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

  private async ensureValidCart(buyer: Buyer, tx?: Prisma.TransactionClient): Promise<Cart & { items: CartItem[] }> {
    if ('guestCartId' in buyer) {
      const cart = await this.cartService.getGuestCartOrThrow(buyer.guestCartId, tx);
      if (cart.items.length === 0) throw new NotFoundException('The guest cart is empty');
      return cart;
    }
    const cart = await this.cartService.getCartOrThrow(buyer.userId, tx);
    if (cart.items.length === 0) throw new NotFoundException(`Cart for user "${buyer.userId}" is empty`);
    return cart;
  }

  private async ensureValidShippingAddress(userId: string, shippingAddressId: string, tx?: Prisma.TransactionClient) {
    const address = await this.ordersRepository.findAddressForUser(shippingAddressId, userId, tx);
    if (!address) {
      throw new NotFoundException(`Shipping address "${shippingAddressId}" not found for user "${userId}"`);
    }
    return address;
  }

  private async ensureUserCanOrder(userId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const user = await this.ordersRepository.findUserById(userId, tx);
    if (!user || !user.isActive) throw new BadRequestException(`User "${userId}" is not eligible to place an order`);
  }

  /**
   * Prices the cart with the pricing engine: the customer's price lists, item and cart promotions (the coupon code
   * unlocking one), the tax the prices include and shipping. The quote is the order snapshot, so the total charged is
   * the quote's grand total. Delivery is priced in two passes: the merchandise total after promotions (which the fee
   * cannot change) sets the zone's fee for the service level, then the cart is priced with that fee, so free-shipping
   * promotions still apply on top of it.
   */
  private async buildOrderDetails(
    cartItems: CartItem[],
    buyer: Buyer,
    shipping: Pick<Fulfilment, 'zone' | 'shippingZoneId' | 'fulfilmentLocationIds'>,
    params: Pick<CheckoutParams, 'couponCode' | 'serviceLevel' | 'deliverySlot' | 'redeemPoints'>,
    tx: Prisma.TransactionClient | undefined,
  ): Promise<{
    snapshot: OrderSnapshot;
    couponCode?: { id: string; promotionId: string };
    delivery: PricedCheckout['delivery'];
    loyalty: PricingLoyalty | null;
  }> {
    const { couponCode } = params;
    const now = new Date();
    const currency = await this.storeService.getCurrency(tx);
    const variants: VariantForSale[] = [];
    const expired: ExpiredLotUnits[] = [];
    for (const item of cartItems) {
      const checked = await this.checkVariantAvailability(item, currency, shipping.fulfilmentLocationIds, now, tx);
      variants.push(checked.variant);
      expired.push(...checked.expired);
    }
    this.assertOneLocationFills(cartItems, variants, shipping.fulfilmentLocationIds, expired);
    const unique = (ids: (string | null)[]) => [...new Set(ids.filter((id): id is string => id !== null))];
    const facts = await this.promotionsService.findForPricing(
      {
        variantIds: unique(variants.map((variant) => variant.id)),
        productIds: unique(variants.map((variant) => variant.productId)),
        categoryIds: unique(variants.map((variant) => variant.product.categoryId)),
        brandIds: unique(variants.map((variant) => variant.product.brandId)),
      },
      'userId' in buyer ? buyer.userId : null,
      couponCode,
      now,
      tx,
    );
    const promotions = 'userId' in buyer ? facts : guestPricingFacts(facts);
    const priceLists = await this.priceListsService.findForPricing(
      unique(variants.map((variant) => variant.id)),
      promotions.customer.groupIds,
      now,
      tx,
    );
    const taxes = await this.taxService.findActive(tx);
    // In the order transaction this locks the customer's loyalty account until the order commits.
    const loyalty = 'userId' in buyer ? await this.loyalty.pricingFacts(buyer.userId, now, tx) : null;
    const redeemPoints = params.redeemPoints ?? 0;

    const priceWith = (shippingFee: Decimal, delivery: Quote['delivery'], points: number) =>
      this.priceOrThrow(tx !== undefined, () =>
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
            shippingZoneId: shipping.shippingZoneId,
            delivery,
            redeemPoints: points,
          },
          {
            currency,
            now,
            promotions: promotions.promotions,
            taxRates: taxes.map((tax) => ({ id: tax.id, name: tax.name, rate: tax.rate })),
            customer: promotions.customer,
            priceLists,
            loyalty,
          },
        ),
      );
    // The delivery fee depends on the goods after promotions, never on the points that pay part of them.
    const merchandise = priceWith(new Decimal(0), null, 0);
    if (!shipping.zone && params.deliverySlot) throw slotUnavailable('Pickup orders have no delivery slot');
    const fee = shipping.zone && this.priceDelivery(shipping.zone, variants, cartItems, merchandise, params);
    const delivery = fee && { ...fee, ...(await this.chooseSlot(fee.quote, params.deliverySlot, now, tx)) };
    const slot = delivery?.quote.slot;
    const quote = delivery
      ? priceWith(
          delivery.quote.fee,
          {
            rateRuleId: delivery.quote.rateRuleId,
            serviceLevel: delivery.quote.serviceLevel,
            slot: slot
              ? { slotId: slot.slotId, date: slot.date, startMinute: slot.startMinute, endMinute: slot.endMinute }
              : null,
          },
          redeemPoints,
        )
      : redeemPoints > 0
        ? priceWith(new Decimal(0), null, redeemPoints)
        : merchandise;
    const snapshot: OrderSnapshot = {
      ...quote,
      lines: quote.lines.map((line) => ({
        ...line,
        productName: variants[line.cartLineIndex].product.name,
        sku: variants[line.cartLineIndex].sku,
        optionValues: variants[line.cartLineIndex].optionValues,
      })),
    };
    const applied = appliedPromotionIds(quote);
    const code = promotions.couponCode;
    return {
      snapshot,
      couponCode: code && applied.includes(code.promotionId) ? code : undefined,
      delivery,
      loyalty,
    };
  }

  /**
   * The zone's fee for each service level it offers, for the cart's weight and its merchandise total after item and
   * cart promotions, and the one asked for (default STANDARD; one the zone does not offer: BAD_REQUEST with reason
   * DELIVERY_LEVEL_UNAVAILABLE). A variant without a weight counts 0 g (logged when the fee depends on weight).
   */
  private priceDelivery(
    zone: DeliveryZone,
    variants: VariantForSale[],
    cartItems: CartItem[],
    merchandise: Quote,
    params: Pick<CheckoutParams, 'serviceLevel'>,
  ): { quote: Omit<DeliveryQuote, 'slot'>; options: DeliveryFee[] } {
    const weightGrams = variants.reduce(
      (sum, variant, index) => sum + (variant.weightGrams ?? 0) * cartItems[index].quantity,
      0,
    );
    const merchandiseTotal = merchandise.subtotal.sub(merchandise.discountTotal);
    const options = offeredLevels(zone.rules).map((level) =>
      deliveryFee(zone.rules, level, weightGrams, merchandiseTotal)!,
    );
    const level = params.serviceLevel ?? DeliveryServiceLevel.STANDARD;
    const chosen = options.find((option) => option.serviceLevel === level);
    if (!chosen) {
      throw new BadRequestException({
        message: `${level} delivery is not offered in zone "${zone.name}" (offered: ${options.map((option) => option.serviceLevel).join(', ')})`,
        extensions: { reason: DELIVERY_LEVEL_UNAVAILABLE },
      });
    }
    const unweighed = variants.filter((variant) => variant.weightGrams === null).map((variant) => variant.id);
    if (unweighed.length > 0 && zone.rules.some((rule) => rule.weightBands.length > 0)) {
      this.logger.warn(
        `Delivery weight counts 0 g for variants without a weight | zoneId: ${zone.id} | variantIds: ${unweighed.join(',')}`,
        'OrdersService',
      );
    }
    return { quote: { ...chosen, zoneId: zone.id, zoneName: zone.name, weightGrams }, options };
  }

  /**
   * The zone's slots for STANDARD delivery (EXPRESS is as soon as possible, without slots) and the one asked for:
   * BAD_REQUEST with reason DELIVERY_SLOT_UNAVAILABLE when it is not one the zone offers now (unknown, closed date, past
   * its cutoff, EXPRESS or a zone without slots), CONFLICT with reason SLOT_FULL when it has no place left. Placement
   * books it with a conditional increment, so the place shown here can still go to another order meanwhile.
   */
  private async chooseSlot(
    fee: Omit<DeliveryQuote, 'slot'>,
    wanted: CheckoutParams['deliverySlot'],
    now: Date,
    tx: Prisma.TransactionClient | undefined,
  ): Promise<{ quote: DeliveryQuote; slots: AvailableSlot[]; slotRequired: boolean }> {
    if (fee.serviceLevel !== DeliveryServiceLevel.STANDARD) {
      if (wanted) throw slotUnavailable(`${fee.serviceLevel} delivery has no delivery slots`);
      return { quote: { ...fee, slot: null }, slots: [], slotRequired: false };
    }
    const calendar = await this.deliverySlots.calendar(fee.zoneId, now, tx);
    const slotRequired = calendar.templates.some((template) => template.isActive);
    if (!wanted) return { quote: { ...fee, slot: null }, slots: upcomingSlots(calendar, now), slotRequired };
    const slot = bookableSlot(calendar, now, wanted);
    if (!slot) throw slotUnavailable(`Delivery slot "${wanted.slotId}" on ${wanted.date} cannot be booked`);
    if (slot.remaining === 0) {
      throw new ConflictException({
        message: 'That delivery slot is fully booked: choose another one',
        extensions: { reason: SLOT_FULL },
      });
    }
    return { quote: { ...fee, slot }, slots: upcomingSlots(calendar, now), slotRequired };
  }

  /**
   * Runs the engine, turning its refusals into client errors. Points the balance no longer covers are a CONFLICT with
   * reason LOYALTY_BALANCE_CHANGED inside the order transaction (they were there at the quote).
   */
  private priceOrThrow<T>(placing: boolean, pricing: () => T): T {
    try {
      return pricing();
    } catch (error) {
      if (error instanceof CouponNotApplicableError) throw new BadRequestException(error.message);
      if (error instanceof PointsNotRedeemableError) {
        if (error.reason === PointsRefusal.LOYALTY_DISABLED) throw featureDisabled('LOYALTY');
        if (placing && error.reason === PointsRefusal.INSUFFICIENT_POINTS) {
          throw new ConflictException({ message: error.message, extensions: { reason: LOYALTY_BALANCE_CHANGED } });
        }
        throw new BadRequestException({ message: error.message, extensions: { reason: error.reason } });
      }
      throw error;
    }
  }

  private async checkVariantAvailability(
    item: CartItem,
    currency: Currency,
    locationIds: string[],
    now: Date,
    tx: Prisma.TransactionClient | undefined,
  ): Promise<{ variant: VariantForSale; expired: ExpiredLotUnits[] }> {
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
    // Only lot-tracked variants have expired units. Inside the order transaction the locked levels already leave
    // them out (lockLevels), so the read is skipped there to keep the locked section short.
    const expired =
      variant.product.trackLots && !tx ? await this.ordersRepository.findExpiredLotUnits([variant.id], now) : [];
    const available = sellableQuantity(
      sellableLevels(variant.id, variant.stockLevels, expired).filter((level) =>
        locationIds.includes(level.locationId),
      ),
    );
    if (available < item.quantity) {
      throw new BadRequestException(
        `Insufficient stock for "${variant.product.name}" (${variant.sku}): ${available} available, ${item.quantity} requested`,
      );
    }
    return { variant, expired };
  }

  /** Every line passed on its own; the whole order must also come from one location (see placeOrder). */
  private assertOneLocationFills(
    cartItems: CartItem[],
    variants: VariantForSale[],
    locationIds: string[],
    expired: ExpiredLotUnits[],
  ): void {
    const levels = variants.flatMap((variant) =>
      sellableLevels(variant.id, variant.stockLevels, expired).map((level) => ({ ...level, variantId: variant.id })),
    );
    if (!chooseFulfilmentLocation(locationIds, cartItems, levels)) throw notAllAtOneLocation();
  }

  /**
   * Writes the order from the priced checkout, reserves its stock at one location and the uses of the promotions it
   * applies (see PromotionsService.reserveRedemptions), on the caller's tx. The location is the first of the
   * fulfilment list that can fill every line, chosen with the stock levels locked (StockLocationsService).
   */
  private async placeOrder(
    tx: Prisma.TransactionClient,
    checkout: PricedCheckout,
    params: CreateOrderParams,
    codPhone: string | undefined,
  ): Promise<Order & { items: OrderItem[] }> {
    const { fulfilment, buyer } = checkout;
    const userId = 'userId' in buyer ? buyer.userId : null;
    const actorId = userId ?? undefined;
    const orderDetails = {
      snapshot: checkout.snapshot,
      couponCodeId: checkout.couponCode?.id,
      paymentMethod: params.paymentMethod ?? PaymentMethod.ONLINE,
      contactEmail: params.contactEmail,
      contactPhone: params.contactPhone,
      codPhone,
      fulfillmentType: params.fulfillmentType,
      shippingAddressId: fulfilment.shippingAddressId,
      shippingAddressSnapshot: fulfilment.shippingAddressSnapshot,
      pickupLocationId: fulfilment.pickupLocationId,
      pickupLocationSnapshot: fulfilment.pickupLocationSnapshot,
      shippingZoneName: fulfilment.zone?.name,
      ...(userId === null && {
        guestPhone: params.contactPhone,
        guestPhoneVerifiedAt: checkout.cart.guestPhoneVerifiedAt,
        contactName: params.contactName,
      }),
    };
    const cartId = checkout.cart.id;
    const isCod = orderDetails.paymentMethod === PaymentMethod.CASH_ON_DELIVERY;
    const chosen = await this.stockLocations.lockFulfilmentLocation(
      tx,
      fulfilment.fulfilmentLocationIds,
      checkout.cart.items,
    );
    if (chosen.locationId === null) {
      const { shortVariantId } = chosen;
      const short = checkout.snapshot.lines.find((line) => line.variantId === shortVariantId);
      throw short ? outOfStock(short.sku) : notAllAtOneLocation();
    }
    const stockLocationId: string = chosen.locationId;
    const newOrder = await this.ordersRepository.create(tx, userId, { ...orderDetails, stockLocationId });
    const slot = checkout.delivery?.quote.slot;
    if (slot) await this.deliverySlots.book(tx, slot);

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
            locationId: stockLocationId,
          },
          actorId,
        ));
      if (!reserved) throw outOfStock(item.sku);
    }

    await this.promotionsService.reserveRedemptions(
      tx,
      { orderId: newOrder.id, customerId: userId },
      appliedPromotionIds(checkout.snapshot),
      checkout.couponCode,
      discountedUnits(checkout.snapshot),
    );
    const redemption = checkout.snapshot.loyaltyRedemption;
    if (redemption && userId) await this.loyalty.redeem(tx, userId, newOrder.id, redemption.points, new Date());
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
      { actorId, reason: 'Cash on delivery accepted' },
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
   * promotion uses are given back (unless the order was paid) and an open payment intent is cancelled in the same
   * transaction.
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
      await this.loyalty.settleOrder(tx, order.id, new Date());
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
      // A paid order keeps its promotion uses, even when refunded (Emmanuel, 2026-11-21); only an unpaid one gives
      // them back.
      if (!(await this.ordersRepository.hasCapturedPayment(order.id, tx))) {
        await this.promotionsService.releaseRedemptions(tx, order.id);
      }
      await this.stockLedger.releaseOrder(tx, order.id, {
        actorId: close.actorId,
        note: close.to === OrderStatus.EXPIRED ? 'Unpaid order expired' : 'Order cancelled',
      });
      await this.ordersRepository.cancelOpenShipments(tx, order.id, { actorId: close.actorId, reason: close.reason });
      await this.serialUnits.releaseOrder(tx, order.id, { actorId: close.actorId, refType: 'Order', refId: order.id });
      await this.deliverySlots.releaseForOrder(tx, order.id);
      await this.ordersRepository.cancelOpenPaymentIntent(tx, order.id);
      if (close.to === OrderStatus.CANCELLED && order.paymentMethod === PaymentMethod.ONLINE) {
        await this.refunds.openCancellationRefund(tx, order.id, close.actorId);
      }
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
}
