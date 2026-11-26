import { UseInterceptors } from '@nestjs/common';
import { Args, Context, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { CountCartStarts, CountCheckoutQuotes } from '../analytics/counters/counting.interceptors';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { AddToCartInput } from '../cart/dto/add-to-cart.input';
import { UpdateCartItemInput } from '../cart/dto/update-cart.input';
import { CheckoutQuote } from '../order/entities/checkout-quote.entity';
import { TrackingStep } from '../order/entities/tracking-step.entity';
import { PaymentIntentStatusEnum } from '../order/enums/order.enum';
import { OrdersService } from '../order/order.service';
import { ShipmentHistory, trackingTimeline } from '../order/tracking-timeline';
import { PhoneVerificationRequest, VerifyPhoneInput } from '../phone-verification/phone-verification.entities';
import { PaymentIntentStatus } from '../generated/prisma/client';
import { GuestCheckoutService } from './guest-checkout.service';
import {
  CreateGuestOrderInput,
  GuestCart,
  GuestCartSession,
  GuestCheckoutQuoteInput,
  GuestOrder,
  GuestOrderPlacement,
  GuestPhoneInput,
} from './guest-checkout.entities';
import { RequireFeature } from '../store-features/require-feature';

const SENSITIVE = { auth: { ttl: 60000, limit: 5 } };
// Guests poll their order for tracking; the token is unguessable, so this only caps a misbehaving client.
const ORDER_READS = { global: { ttl: 60000, limit: 30 } };
const TOKEN_ARG = { name: 'guestCartToken', description: 'The token createGuestCart returned' } as const;
const ACCESS_ARG = { name: 'orderAccessToken', description: 'The token createGuestOrder returned' } as const;

type GuestOrderWithHistory = GuestOrder & {
  statusEvents?: Parameters<typeof trackingTimeline>[0];
  shipments?: ShipmentHistory[];
  paymentIntent?: { status: PaymentIntentStatus } | null;
};

/** Guest checkout (P6-G.1): public operations, each authorised by the guest cart token or the order access token. */
@Auth(AuthType.None)
@Resolver(() => GuestOrder)
export class GuestCheckoutResolver {
  constructor(
    private readonly guestCheckout: GuestCheckoutService,
    private readonly orders: OrdersService,
  ) {}

  @Throttle(SENSITIVE)
  @RequireFeature('GUEST_CHECKOUT')
  @Mutation(() => GuestCartSession, { description: 'Start a guest cart; every guest cart call takes its token' })
  createGuestCart() {
    return this.guestCheckout.createCart();
  }

  @Query(() => GuestCart, { description: 'The guest cart; NOT_FOUND for an unknown or expired token' })
  guestCart(@Args(TOKEN_ARG.name, { description: TOKEN_ARG.description }) token: string) {
    return this.guestCheckout.getCart(token);
  }

  @UseInterceptors(CountCartStarts)
  @RequireFeature('GUEST_CHECKOUT')
  @Mutation(() => GuestCart, { description: 'Add a variant to the guest cart (as addToCart)' })
  addToGuestCart(
    @Args(TOKEN_ARG.name, { description: TOKEN_ARG.description }) token: string,
    @Args('input') input: AddToCartInput,
  ) {
    return this.guestCheckout.addItem(token, input);
  }

  @RequireFeature('GUEST_CHECKOUT')
  @Mutation(() => GuestCart, { description: 'Set the quantity of a guest cart line, 0 removes it (as updateCartItem)' })
  updateGuestCartItem(
    @Args(TOKEN_ARG.name, { description: TOKEN_ARG.description }) token: string,
    @Args('input') input: UpdateCartItemInput,
  ) {
    return this.guestCheckout.updateItem(token, input);
  }

  @RequireFeature('GUEST_CHECKOUT')
  @Mutation(() => GuestCart, { description: 'Remove a line from the guest cart' })
  removeFromGuestCart(
    @Args(TOKEN_ARG.name, { description: TOKEN_ARG.description }) token: string,
    @Args('cartItemId') cartItemId: string,
  ) {
    return this.guestCheckout.removeItem(token, cartItemId);
  }

  @Throttle(SENSITIVE)
  @RequireFeature('GUEST_CHECKOUT')
  @Mutation(() => PhoneVerificationRequest, {
    description:
      'Text a 6-digit code to the phone the guest orders with (valid 10 minutes; same limits as requestPhoneVerification: ' +
      'BAD_REQUEST with reason OTP_RATE_LIMITED, PHONE_ALREADY_VERIFIED). A new number replaces a verified one',
  })
  requestGuestPhoneVerification(
    @Args(TOKEN_ARG.name, { description: TOKEN_ARG.description }) token: string,
    @Args('input') input: GuestPhoneInput,
  ) {
    return this.guestCheckout.requestPhoneCode(token, input.phone);
  }

  @Throttle(SENSITIVE)
  @RequireFeature('GUEST_CHECKOUT')
  @Mutation(() => GuestCart, {
    description:
      'Confirm the guest phone with the code from the SMS. BAD_REQUEST with reason OTP_INVALID (attemptsRemaining), ' +
      'OTP_ATTEMPTS_EXCEEDED, OTP_EXPIRED or PHONE_REQUIRED (no code requested)',
  })
  verifyGuestPhone(
    @Args(TOKEN_ARG.name, { description: TOKEN_ARG.description }) token: string,
    @Args('input') input: VerifyPhoneInput,
  ) {
    return this.guestCheckout.verifyPhone(token, input.code);
  }

  @UseInterceptors(CountCheckoutQuotes)
  @RequireFeature('GUEST_CHECKOUT')
  @Query(() => CheckoutQuote, {
    description:
      'checkoutQuote for the guest cart: the same breakdown and quoteHash, priced as a visitor (no customer-group, ' +
      'first-order or per-customer-limit promotions: BAD_REQUEST with reason COUPON_NEEDS_ACCOUNT for such a coupon). ' +
      'CASH_ON_DELIVERY: BAD_REQUEST with reason COD_NOT_AVAILABLE and codReason GUEST_CHECKOUT',
  })
  guestCheckoutQuote(
    @Args(TOKEN_ARG.name, { description: TOKEN_ARG.description }) token: string,
    @Args('input') input: GuestCheckoutQuoteInput,
  ) {
    return this.guestCheckout.quote(token, input);
  }

  @Throttle(SENSITIVE)
  @RequireFeature('GUEST_CHECKOUT')
  @Mutation(() => GuestOrderPlacement, {
    description:
      'Place the guest order at the guestCheckoutQuote price, paid online (then POST /payment/guest/initialize). ' +
      'BAD_REQUEST with reason GUEST_PHONE_NOT_VERIFIED before verifyGuestPhone; CONFLICT with reason QUOTE_CHANGED; ' +
      'FORBIDDEN with reason VELOCITY_LIMIT when too many orders came from the phone or network',
  })
  createGuestOrder(
    @Args(TOKEN_ARG.name, { description: TOKEN_ARG.description }) token: string,
    @Args('input') input: CreateGuestOrderInput,
    @Context('req') req: Request,
  ) {
    return this.guestCheckout.placeOrder(token, input, req.ip);
  }

  @Throttle(ORDER_READS)
  @Query(() => GuestOrder, { description: 'The guest order of the access token; NOT_FOUND for any other token' })
  guestOrder(@Args(ACCESS_ARG.name, { description: ACCESS_ARG.description }) orderAccessToken: string) {
    return this.guestCheckout.getOrder(orderAccessToken);
  }

  @Throttle(SENSITIVE)
  @Mutation(() => GuestOrder, {
    description:
      'Check a payment of the guest order with the provider after its redirect (as verifyPayment); FORBIDDEN for a ' +
      'reference of another order',
  })
  verifyGuestPayment(
    @Args(ACCESS_ARG.name, { description: ACCESS_ARG.description }) orderAccessToken: string,
    @Args('reference') reference: string,
  ) {
    return this.guestCheckout.verifyPayment(orderAccessToken, reference);
  }

  @ResolveField(() => PaymentIntentStatusEnum, { nullable: true, description: "The order payment's status" })
  async paymentStatus(@Parent() order: GuestOrderWithHistory) {
    if (order.paymentIntent !== undefined) return order.paymentIntent?.status ?? null;
    return this.orders.getPaymentStatus(order.id);
  }

  @ResolveField(() => [TrackingStep], { description: 'Order and shipment status changes, oldest first' })
  async trackingTimeline(@Parent() order: GuestOrderWithHistory): Promise<TrackingStep[]> {
    const [events, shipments] = await Promise.all([
      order.statusEvents ?? this.orders.getTimeline(order.id),
      order.shipments ?? this.orders.getShipments(order.id),
    ]);
    return trackingTimeline(events, shipments);
  }
}
