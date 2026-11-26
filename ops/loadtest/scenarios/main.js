// P9-L load test: storefront and back-office traffic at 3x the assumed peak (about 30 concurrent shoppers and 50
// orders an hour, so 90 shoppers and 150 orders an hour). PROFILE=smoke runs every scenario once; PROFILE=peak3x
// (default) runs the load; SCALE multiplies its users and order rate (e.g. SCALE=2 to look for the knee).
import { check, sleep } from 'k6';
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import { Rate, Trend } from 'k6/metrics';
import { gql, postJson, shopperIp, signIn } from '../lib/client.js';
import * as Q from '../lib/queries.js';

const fixtures = JSON.parse(open('../fixtures.json'));
const PASSWORD = __ENV.LOAD_USER_PASSWORD;
const PAYSTACK_SECRET_KEY = __ENV.PAYSTACK_SECRET_KEY;
const PROFILE = __ENV.PROFILE || 'peak3x';
const SCALE = Number(__ENV.SCALE || 1);
if (!PASSWORD) throw new Error('LOAD_USER_PASSWORD is required (the seeded customers and staff share it)');
if (!PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY is required to sign the payment webhooks');

// Customers 0-499 shop (cart and quote), 500-999 place orders: a placing customer never has a cart being edited.
const SHOPPERS = fixtures.customerCount / 2;
const PAYSTACK_IP = '52.31.139.75';

const orderConfirmed = new Rate('order_confirmed');
const orderConfirmSeconds = new Trend('order_confirm_seconds');

const fill = (template, n) => template.replace('{n}', String(n));
const pick = (items) => items[Math.floor(Math.random() * items.length)];
const between = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const think = (min, max) => sleep(PROFILE === 'smoke' ? 0 : min + Math.random() * (max - min));
// Most views go to a popular fifth of the catalogue, like real traffic.
const popularProduct = () =>
  Math.random() < 0.8 ? between(0, fixtures.productCount / 5 - 1) : between(0, fixtures.productCount - 1);
const variantOf = (n) => `load_var_${n}_${n % fixtures.apparelEvery === 0 ? 0 : between(0, fixtures.sizes.length - 1)}`;
const day = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

function ramping(target, flow) {
  return {
    executor: 'ramping-vus',
    exec: flow,
    startVUs: 0,
    stages: [
      { duration: '2m', target: Math.max(1, Math.round(target * SCALE)) },
      { duration: '10m', target: Math.max(1, Math.round(target * SCALE)) },
      { duration: '1m', target: 0 },
    ],
    gracefulRampDown: '30s',
    tags: { flow },
  };
}

const once = (flow) => ({ executor: 'per-vu-iterations', exec: flow, vus: 1, iterations: 1, tags: { flow } });

const SCENARIOS = {
  smoke: {
    browse: once('browse'),
    product: once('product'),
    cart: once('cart'),
    checkout: once('checkout'),
    staff: once('staff'),
  },
  peak3x: {
    browse: ramping(55, 'browse'),
    product: ramping(20, 'product'),
    cart: ramping(12, 'cart'),
    // 150 orders an hour = 5 every 2 minutes, for the 13 minutes of the run.
    checkout: {
      executor: 'constant-arrival-rate',
      exec: 'checkout',
      rate: Math.max(1, Math.round(5 * SCALE)),
      timeUnit: '2m',
      duration: '13m',
      preAllocatedVUs: 4,
      maxVUs: 20,
      tags: { flow: 'checkout' },
    },
    staff: ramping(3, 'staff'),
  },
};

export const options = {
  scenarios: SCENARIOS[PROFILE],
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'http_req_duration{flow:browse}': ['p(95)<300', 'p(99)<800'],
    'http_req_duration{flow:product}': ['p(95)<300', 'p(99)<800'],
    'http_req_duration{flow:cart}': ['p(95)<800'],
    'http_req_duration{op:checkoutQuote}': ['p(95)<800'],
    'http_req_duration{op:createOrder}': ['p(95)<800'],
    // Includes the stub's 300 ms of simulated Paystack latency.
    'http_req_duration{op:paymentInitialize}': ['p(95)<1200'],
    'http_req_duration{op:paystackWebhook}': ['p(95)<300'],
    'http_req_duration{flow:staff}': ['p(95)<1000'],
    order_confirmed: ['rate>0.99'],
    order_confirm_seconds: ['p(95)<10'],
  },
};

function browseFilter() {
  const filter = {};
  const kind = Math.random();
  if (kind < 0.35) filter.categoryId = `load_cat_${between(0, fixtures.categoryCount - 1)}`;
  else if (kind < 0.55) filter.brandId = `load_brand_${between(0, fixtures.brandCount - 1)}`;
  else if (kind < 0.8) filter.search = pick(fixtures.searchTerms);
  if (Math.random() < 0.3) {
    filter.priceMin = String(between(10, 200));
    filter.priceMax = String(between(300, 900));
  }
  if (Math.random() < 0.3) filter.inStock = true;
  return filter;
}

export function browse() {
  if (Math.random() < 0.5) gql('browse', 'homepage', Q.HOMEPAGE);
  else
    gql('browse', 'collection', Q.COLLECTION, {
      slug: pick(['load-featured-1', 'load-featured-2', 'load-all-phones', 'load-brand-5-picks']),
    });
  think(1, 3);

  const filter = browseFilter();
  const sort =
    Math.random() < 0.3
      ? { sortBy: pick(['NAME', 'CREATED_AT', 'UPDATED_AT']), sortOrder: pick(['ASC', 'DESC']) }
      : undefined;
  const listing = gql('browse', 'products', Q.PRODUCTS, { filter, page: { first: 24 }, sort });
  gql('browse', 'productFacets', Q.FACETS, { filter });
  think(1, 3);

  const edges = listing ? listing.products.edges : [];
  if (edges.length > 0 && listing.products.pageInfo.hasNextPage && Math.random() < 0.4) {
    gql('browse', 'products', Q.PRODUCTS, { filter, page: { first: 24, after: edges[edges.length - 1].cursor }, sort });
    think(1, 3);
  }
  const prefix = pick(fixtures.suggestionPrefixes);
  gql('browse', 'searchSuggestions', Q.SUGGESTIONS, { prefix });
  gql('browse', 'searchSuggestions', Q.SUGGESTIONS, { prefix: `${prefix}${pick(['t', 'a', 'r'])}` });
  think(1, 3);
}

export function product() {
  const page = gql('product', 'productBySlug', Q.PRODUCT_PAGE, { slug: fill(fixtures.productSlug, popularProduct()) });
  if (page && page.productBySlug)
    gql('product', 'productReviews', Q.PRODUCT_REVIEWS, { productId: page.productBySlug.id });
  think(2, 5);
}

const tokens = {};
function tokenFor(flow, email) {
  if (!tokens[email]) tokens[email] = signIn(flow, email, PASSWORD);
  return tokens[email];
}

export function cart() {
  const customer = (exec.vu.idInTest - 1) % SHOPPERS;
  const token = tokenFor('cart', fill(fixtures.customerEmail, customer));
  if (!token) return;
  const auth = { token };

  const current = gql('cart', 'cart', Q.CART, {}, auth);
  if (current && current.cart && current.cart.items.length >= 4) gql('cart', 'clearCart', Q.CLEAR_CART, {}, auth);
  gql(
    'cart',
    'addToCart',
    Q.ADD_TO_CART,
    { input: { variantId: variantOf(popularProduct()), quantity: between(1, 2) } },
    auth,
  );
  think(1, 3);
  gql('cart', 'cart', Q.CART, {}, auth);
  gql(
    'cart',
    'checkoutQuote',
    Q.CHECKOUT_QUOTE,
    { input: { fulfillmentType: 'DELIVERY', shippingAddressId: `load_address_${customer}` } },
    auth,
  );
  think(2, 5);
}

function paystackWebhook(reference, amountMinor) {
  const body = JSON.stringify({
    event: 'charge.success',
    data: { id: Math.floor(Math.random() * 1e12), reference, amount: amountMinor, currency: 'GHS', status: 'success' },
  });
  const signature = crypto.hmac('sha512', PAYSTACK_SECRET_KEY, body, 'hex');
  return postJson('checkout', 'paystackWebhook', '/payment/webhook', body, {
    ip: PAYSTACK_IP,
    extraHeaders: { 'x-paystack-signature': signature },
  });
}

export function checkout() {
  // A new customer and session per order, each from its own address.
  const customer = SHOPPERS + (exec.scenario.iterationInTest % SHOPPERS);
  const ip = shopperIp(10_000 + exec.scenario.iterationInTest);
  const token = signIn('checkout', fill(fixtures.customerEmail, customer), PASSWORD, ip);
  if (!token) return;
  const auth = { token, ip };
  const cod = PROFILE !== 'smoke' && Math.random() < 0.3;

  const existing = gql('checkout', 'cart', Q.CART, {}, auth);
  if (existing && existing.cart && existing.cart.items.length > 0) gql('checkout', 'clearCart', Q.CLEAR_CART, {}, auth);
  const lines = cod ? 1 : between(1, 3);
  for (let i = 0; i < lines; i++) {
    gql(
      'checkout',
      'addToCart',
      Q.ADD_TO_CART,
      { input: { variantId: variantOf(popularProduct()), quantity: 1 } },
      auth,
    );
  }
  const choice = {
    fulfillmentType: 'DELIVERY',
    shippingAddressId: `load_address_${customer}`,
    paymentMethod: cod ? 'CASH_ON_DELIVERY' : 'ONLINE',
  };
  const quote = gql('checkout', 'checkoutQuote', Q.CHECKOUT_QUOTE, { input: choice }, auth);
  if (!quote) return;
  think(2, 6);

  const placed = gql(
    'checkout',
    'createOrder',
    Q.CREATE_ORDER,
    {
      input: Object.assign({}, choice, {
        quoteHash: quote.checkoutQuote.quoteHash,
        contactEmail: fill(fixtures.customerEmail, customer),
        contactPhone: `+23324${1_000_000 + customer}`,
      }),
    },
    auth,
  );
  if (!placed || cod) return;
  const order = placed.createOrder;

  const init = postJson(
    'checkout',
    'paymentInitialize',
    '/payment/initialize',
    { orderId: order.id, paymentMethod: 'CARD', idempotencyKey: `load-${order.id}` },
    auth,
  );
  const attempt = init.status === 201 || init.status === 200 ? init.json() : null;
  if (
    !check(
      init,
      { 'paymentInitialize: 2xx with a reference': () => !!(attempt && attempt.transactionId) },
      { flow: 'checkout' },
    )
  ) {
    console.warn(`paymentInitialize failed: HTTP ${init.status} ${String(init.body).slice(0, 200)}`);
    orderConfirmed.add(false);
    return;
  }
  think(3, 8);

  const amountMinor = Math.round(Number(order.grandTotal.amount) * 100);
  const sentAt = Date.now();
  const ack = paystackWebhook(attempt.transactionId, amountMinor);
  check(ack, { 'paystackWebhook: 200': (r) => r.status === 200 }, { flow: 'checkout' });

  let confirmed = false;
  for (let i = 0; i < 30 && !confirmed; i++) {
    sleep(1);
    const status = gql('checkout', 'orderStatus', Q.ORDER_STATUS, { id: order.id }, auth);
    confirmed = !!status && status.order.status === 'CONFIRMED';
  }
  orderConfirmed.add(confirmed);
  if (confirmed) orderConfirmSeconds.add((Date.now() - sentAt) / 1000);
}

export function staff() {
  const token = tokenFor('staff', fill(fixtures.staffEmail, (exec.vu.idInTest - 1) % fixtures.staffCount));
  if (!token) return;
  const auth = { token };
  const range = { firstDay: day(-30), lastDay: day(-1) };

  const list = gql('staff', 'orders', Q.STAFF_ORDERS, {}, auth);
  const orders = list ? list.orders : [];
  if (orders.length > 0) gql('staff', 'viewOrder', Q.VIEW_ORDER, { id: pick(orders).id }, auth);
  think(3, 8);
  gql('staff', 'dashboardSummary', Q.DASHBOARD, {}, auth);
  gql('staff', 'salesReport', Q.SALES_REPORT, range, auth);
  gql('staff', 'topProducts', Q.TOP_PRODUCTS, range, auth);
  think(5, 10);
}
