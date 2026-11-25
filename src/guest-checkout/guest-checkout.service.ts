import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cart, CartItem, FulfillmentType, Order, OrderItem, PaymentMethod } from '../generated/prisma/client';
import { CartService } from '../cart/cart.service';
import { CartRepository } from '../cart/cart.repository';
import { AddToCartInput } from '../cart/dto/add-to-cart.input';
import { UpdateCartItemInput } from '../cart/dto/update-cart.input';
import { CheckoutParams, CheckoutQuote, OrdersService } from '../order/order.service';
import { PaymentService } from '../payment/payment.service';
import { PaymentRecord } from '../payment/payment.repository';
import { OnlinePaymentMethod } from '../payment/settings/payment-methods';
import {
  PhoneVerificationRequestResult,
  PhoneVerificationService,
} from '../phone-verification/phone-verification.service';
import { PhoneVerificationReason as Reason } from '../phone-verification/phone-otp';
import { STORE_COUNTRY } from '../addresses/dto/create-address.input';
import { LoggerService } from '../commons/logger.service';
import { StoreFeaturesService } from '../store-features/store-features.service';
import { guestCartExpiry, guestCartTokenHash, newGuestCartToken } from './guest-cart-token';
import { GuestOrderAccess } from './guest-order-access';
import { assertGuestPhoneVerified, guestPayerEmail } from './guest-checkout-rules';
import { CreateGuestOrderInput, GuestCart, GuestCheckoutQuoteInput } from './guest-checkout.entities';

const CONTEXT = 'GuestCheckout';

type CartWithItems = Cart & { items: CartItem[] };

export interface GuestPaymentRequest {
  orderAccessToken: string;
  paymentMethod: OnlinePaymentMethod;
  currency?: string;
  idempotencyKey?: string;
}

function notFound(): NotFoundException {
  return new NotFoundException('Guest cart not found or expired: start a new one with createGuestCart');
}

function orderNotFound(): NotFoundException {
  return new NotFoundException('Order not found');
}

export function toGuestCart(cart: CartWithItems): GuestCart {
  return {
    id: cart.id,
    items: cart.items as unknown as GuestCart['items'],
    phoneLast3: cart.guestPhone?.slice(-3) ?? null,
    phoneVerified: cart.guestPhoneVerifiedAt !== null,
    expiresAt: cart.guestExpiresAt!,
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
  };
}

function checkoutParams(input: GuestCheckoutQuoteInput): CheckoutParams {
  return {
    fulfillmentType: input.fulfillmentType as unknown as FulfillmentType,
    shippingAddress: input.shippingAddress && {
      ...input.shippingAddress,
      country: input.shippingAddress.country ?? STORE_COUNTRY,
    },
    pickupLocationId: input.pickupLocationId,
    couponCode: input.couponCode,
    paymentMethod: input.paymentMethod as PaymentMethod | undefined,
    serviceLevel: input.serviceLevel,
    deliverySlot: input.deliverySlot,
  };
}

/**
 * Guest checkout (P6-G.1): a cart found by an unguessable token (only its hash is stored; 30 days idle expiry), the
 * guest's phone verified by SMS code (PhoneVerificationService, bound to the cart), the order placed and priced by
 * OrdersService like a customer's, and the order then read, paid and tracked with its signed access token.
 */
@Injectable()
export class GuestCheckoutService {
  private readonly frontendUrl: string;

  constructor(
    private readonly carts: CartRepository,
    private readonly cartService: CartService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentService,
    private readonly phoneVerification: PhoneVerificationService,
    private readonly access: GuestOrderAccess,
    private readonly logger: LoggerService,
    private readonly features: StoreFeaturesService,
    config: ConfigService,
  ) {
    this.frontendUrl = config.getOrThrow<string>('FRONTEND_URL');
  }

  async createCart(now = new Date()): Promise<{ guestCartToken: string; cart: GuestCart }> {
    await this.features.assertEnabled('GUEST_CHECKOUT');
    const guestCartToken = newGuestCartToken();
    const created = await this.carts.createGuest(guestCartTokenHash(guestCartToken)!, guestCartExpiry(now));
    return { guestCartToken, cart: toGuestCart({ ...created, items: [] }) };
  }

  async getCart(token: string): Promise<GuestCart> {
    return toGuestCart(await this.cartService.getGuestCartOrThrow((await this.cartFor(token)).id));
  }

  async addItem(token: string, input: AddToCartInput): Promise<GuestCart> {
    return toGuestCart(await this.cartService.addToGuestCart((await this.openCart(token)).id, input));
  }

  async updateItem(token: string, input: UpdateCartItemInput): Promise<GuestCart> {
    return toGuestCart(await this.cartService.updateGuestCartItem((await this.openCart(token)).id, input));
  }

  async removeItem(token: string, cartItemId: string): Promise<GuestCart> {
    return toGuestCart(await this.cartService.removeFromGuestCart((await this.openCart(token)).id, cartItemId));
  }

  /** Texts a code to `phone`; once sent, that phone is the cart's (a different one is no longer verified). */
  async requestPhoneCode(token: string, phone: string): Promise<PhoneVerificationRequestResult> {
    const cart = await this.openCart(token);
    if (cart.guestPhone === phone && cart.guestPhoneVerifiedAt) {
      throw new BadRequestException({
        message: 'This phone number is already verified for this cart',
        extensions: { reason: Reason.PHONE_ALREADY_VERIFIED },
      });
    }
    const sent = await this.phoneVerification.requestGuestCode(cart.id, phone);
    await this.carts.setGuestPhone(cart.id, phone);
    return sent;
  }

  async verifyPhone(token: string, code: string, now = new Date()): Promise<GuestCart> {
    const cart = await this.openCart(token);
    const phone = cart.guestPhone;
    if (!phone) {
      throw new BadRequestException({
        message: 'Request a code first (requestGuestPhoneVerification)',
        extensions: { reason: Reason.PHONE_REQUIRED },
      });
    }
    await this.phoneVerification.checkGuestCode(cart.id, phone, code);
    if (!(await this.carts.markGuestPhoneVerified(cart.id, phone, now))) {
      throw new BadRequestException({
        message: 'The phone number changed since the code was sent; request a new one',
        extensions: { reason: Reason.OTP_EXPIRED },
      });
    }
    this.logger.log(`Guest phone verified | cartId: ${cart.id}`, CONTEXT);
    return this.getCart(token);
  }

  async quote(token: string, input: GuestCheckoutQuoteInput): Promise<CheckoutQuote> {
    return this.orders.guestCheckoutQuote((await this.openCart(token)).id, checkoutParams(input));
  }

  async placeOrder(
    token: string,
    input: CreateGuestOrderInput,
    clientIp?: string,
  ): Promise<{ orderAccessToken: string; order: Order & { items: OrderItem[] } }> {
    const cart = await this.openCart(token);
    // Checked again on the locked cart in the order transaction; this refuses early, before velocity counts.
    assertGuestPhoneVerified(cart, cart.guestPhone ?? '');
    const order = await this.orders.createGuestOrder(cart.id, {
      ...checkoutParams(input),
      contactName: input.contactName.trim(),
      contactEmail: input.contactEmail ?? null,
      contactPhone: cart.guestPhone!,
      quoteHash: input.quoteHash,
      clientIp,
    });
    this.logger.log(`Guest order placed | orderId: ${order.id} | cartId: ${cart.id}`, CONTEXT);
    return { orderAccessToken: this.access.tokenFor(order.id), order };
  }

  /** The guest order the token was issued for; NOT_FOUND for any other token. */
  async getOrder(orderAccessToken: string): Promise<Order & { items: OrderItem[] }> {
    const orderId = this.access.orderIdOf(orderAccessToken);
    const order = orderId ? await this.orders.viewOrder(orderId) : null;
    if (!order || order.deleted || order.guestPhone === null) throw orderNotFound();
    return order;
  }

  async initializePayment(
    request: GuestPaymentRequest,
    clientIp?: string,
  ): Promise<PaymentRecord & { authorizationUrl: string }> {
    const order = await this.getOrder(request.orderAccessToken);
    const { paymentMethod, currency, idempotencyKey } = request;
    return this.payments.initiateGuestPayment(
      order.id,
      { paymentMethod, currency, idempotencyKey },
      guestPayerEmail(order.id, this.frontendUrl),
      clientIp,
    );
  }

  async verifyPayment(orderAccessToken: string, reference: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.getOrder(orderAccessToken);
    await this.payments.verifyGuestPayment(reference, order.id);
    return this.getOrder(orderAccessToken);
  }

  /** cartFor for a change: BAD_REQUEST with reason FEATURE_DISABLED while guest checkout is switched off. */
  private async openCart(token: string): Promise<Cart> {
    await this.features.assertEnabled('GUEST_CHECKOUT');
    return this.cartFor(token);
  }

  private async cartFor(token: string, now = new Date()): Promise<Cart> {
    const hash = guestCartTokenHash(token);
    const cart = hash ? await this.carts.touchGuest(hash, now, guestCartExpiry(now)) : null;
    if (!cart) throw notFound();
    return cart;
  }
}
