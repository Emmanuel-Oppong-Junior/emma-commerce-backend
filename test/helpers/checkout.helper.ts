import { INestApplication } from '@nestjs/common';
import { CreateOrderParams, OrdersService } from '../../src/order/order.service';
import { gqlRequest } from './graphql.helper';

/** A well-formed quoteHash that matches no quote. */
export const ANY_QUOTE_HASH = '0'.repeat(64);

export interface QuoteInput {
  fulfillmentType: 'DELIVERY' | 'PICKUP';
  shippingAddressId?: string;
  pickupLocationId?: string;
  couponCode?: string | null;
}

/**
 * The quoteHash checkoutQuote gives the user for this fulfilment and coupon, which createOrder requires. When
 * checkoutQuote refuses the cart (empty, unknown address, uncovered city...), returns ANY_QUOTE_HASH so the test sees
 * createOrder's own refusal, which comes before the hash is compared.
 */
export async function quoteHashFor(app: INestApplication, token: string, input: QuoteInput): Promise<string> {
  const res = await gqlRequest(
    app,
    `query($input: CheckoutQuoteInput!) { checkoutQuote(input: $input) { quoteHash } }`,
    { input },
    token,
  ).expect(200);
  return res.body.errors ? ANY_QUOTE_HASH : (res.body.data.checkoutQuote.quoteHash as string);
}

/** Places an order through the service the way a client does: quote first, then createOrder with its hash. */
export async function placeOrderFromCart(
  orders: OrdersService,
  userId: string,
  params: Omit<CreateOrderParams, 'quoteHash'>,
) {
  const { quoteHash } = await orders.checkoutQuote(userId, params);
  return orders.createOrderFromCart(userId, { ...params, quoteHash });
}
