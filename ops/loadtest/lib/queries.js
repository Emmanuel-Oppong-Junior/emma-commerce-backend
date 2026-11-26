// The documents a storefront and an admin dashboard would send, selecting what their pages show.
const CARD = 'id name slug images priceRange { min { amount } max { amount } } rating { average count } inStock';

export const HOMEPAGE = `query Homepage { homepage { id type title products { ${CARD} } categories { id name slug }
  brands { id name slug } } }`;

export const COLLECTION = `query Collection($slug: String!) { collection(slug: $slug) { id name
  products(paginationArgs: { first: 24 }) { edges { node { ${CARD} } } pageInfo { hasNextPage } } } }`;

export const PRODUCTS = `query Products($filter: ProductFilterArgs, $page: PaginationArgs, $sort: ProductSortArgs) {
  products(filterArgs: $filter, paginationArgs: $page, sortArgs: $sort) {
    edges { cursor node { ${CARD} } } pageInfo { hasNextPage totalCount } } }`;

export const FACETS = `query Facets($filter: ProductFilterArgs) { productFacets(filterArgs: $filter) {
  totalCount inStockCount categories { id name count } brands { id name count } price { min { amount } max { amount } }
  attributes { key label values { value count } } } }`;

export const SUGGESTIONS = `query Suggest($prefix: String!) { searchSuggestions(prefix: $prefix, first: 5) {
  products { id name } brands { id name } categories { id name } } }`;

export const PRODUCT_PAGE = `query ProductPage($slug: String!) { productBySlug(slug: $slug) {
  id name slug description shortDescription images brand { id name slug } category { id name slug }
  rating { average count distribution { stars count } }
  variants { id sku optionValues available price { amount } discountedPrice { amount } appliedPromotion { id name } } } }`;

export const PRODUCT_REVIEWS = `query Reviews($productId: ID!) { productReviews(productId: $productId, first: 10) {
  id score title comment createdAt verifiedPurchase user { displayName } } }`;

export const ADD_TO_CART = `mutation AddToCart($input: AddToCartInput!) { addToCart(input: $input) { id items { id quantity } } }`;

export const CART = `query Cart { cart { id items { id quantity variantId originalPrice { amount }
  product { id name slug images } variant { id optionValues available price { amount } discountedPrice { amount } } } } }`;

export const CLEAR_CART = 'mutation ClearCart { clearCart { id } }';

export const CHECKOUT_QUOTE = `query Quote($input: CheckoutQuoteInput!) { checkoutQuote(input: $input) {
  quoteHash subtotal { amount } discountTotal { amount } taxTotal { amount } shippingTotal { amount }
  grandTotal { amount } lines { quantity } delivery { zoneName serviceLevel fee { amount } }
  deliveryOptions { serviceLevel fee { amount } } cashOnDelivery { available reason } } }`;

export const CREATE_ORDER = `mutation CreateOrder($input: CreateOrderInput!) { createOrder(input: $input) {
  id orderNumber status grandTotal { amount } } }`;

export const ORDER_STATUS = 'query OrderStatus($id: String!) { order(orderId: $id) { id status paymentStatus } }';

export const STAFF_ORDERS = `query StaffOrders { orders(first: 50) { id orderNumber status paymentMethod fulfillmentType
  grandTotal { amount } createdAt contactPhone items { id productName quantity } } }`;

export const VIEW_ORDER = `query ViewOrder($id: String!) { viewOrder(id: $id) { id orderNumber status grandTotal { amount }
  items { id productName quantity unitListPrice { amount } } timeline { to createdAt } } }`;

export const DASHBOARD = `query Dashboard { dashboardSummary { ordersToday revenueToday { amount }
  grossRevenueToday { amount } refundsToday { amount } lowStockVariantCount lowStockProductCount totalUsers } }`;

export const SALES_REPORT = `query Sales($firstDay: String!, $lastDay: String!) {
  salesReport(firstDay: $firstDay, lastDay: $lastDay, bucket: DAY) {
    totals { paidOrders unitsSold grossRevenue { amount } netRevenue { amount } averageOrderValue { amount } }
    buckets { firstDay paidOrders grossRevenue { amount } } } }`;

export const TOP_PRODUCTS = `query Top($firstDay: String!, $lastDay: String!) {
  topProducts(firstDay: $firstDay, lastDay: $lastDay, first: 10) { productId productName unitsSold sales { amount } } }`;
