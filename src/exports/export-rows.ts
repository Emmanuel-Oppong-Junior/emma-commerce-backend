import { Prisma } from '../generated/prisma/client';
import { CellValue } from '../imports/spreadsheet/table-writer';

export interface ExportTable {
  header: string[];
  rows: CellValue[][];
}

const money = (value: Prisma.Decimal | null | undefined): string | null => value?.toFixed(2) ?? null;

function asObject(json: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
}

const sortedKeys = (objects: Record<string, unknown>[]) => [...new Set(objects.flatMap(Object.keys))].sort();

const cell = (value: unknown): CellValue =>
  value === null || value === undefined
    ? null
    : typeof value === 'number' || typeof value === 'boolean'
      ? value
      : String(value);

export interface ProductExportVariant {
  sku: string;
  barcode: string | null;
  basePrice: Prisma.Decimal | null;
  price: Prisma.Decimal | null;
  weightGrams: number | null;
  lowStockThreshold: number | null;
  isActive: boolean;
  optionValues: Prisma.JsonValue;
  /** On-hand units by location id */
  onHand: Map<string, number>;
  product: {
    id: string;
    name: string;
    status: string | null;
    isTaxable: boolean;
    attributes: Prisma.JsonValue;
    productType: string;
    category: string | null;
    subcategory: string | null;
    brand: string | null;
    tags: string[];
  };
}

/**
 * One row per variant. The leading columns use the products import's names (attr.<key>, option.<key>), followed by
 * the selling price and the on-hand stock at each location (on_hand.<location name>).
 */
export function productExportTable(
  variants: readonly ProductExportVariant[],
  locations: readonly { id: string; name: string }[],
): ExportTable {
  const attributeKeys = sortedKeys(variants.map((variant) => asObject(variant.product.attributes)));
  const optionKeys = sortedKeys(variants.map((variant) => asObject(variant.optionValues)));
  const header = [
    'sku',
    'product_id',
    'name',
    'product_type',
    'category',
    'subcategory',
    'brand',
    'tags',
    'status',
    'is_taxable',
    'barcode',
    'base_price',
    'price',
    'weight_grams',
    'low_stock_threshold',
    'is_active',
    ...attributeKeys.map((key) => `attr.${key}`),
    ...optionKeys.map((key) => `option.${key}`),
    ...locations.map((location) => `on_hand.${location.name}`),
  ];
  const rows = variants.map((variant) => {
    const { product } = variant;
    const attributes = asObject(product.attributes);
    const options = asObject(variant.optionValues);
    return [
      variant.sku,
      product.id,
      product.name,
      product.productType,
      product.category,
      product.subcategory,
      product.brand,
      product.tags.join('|') || null,
      product.status,
      product.isTaxable,
      variant.barcode,
      money(variant.basePrice),
      money(variant.price),
      variant.weightGrams,
      variant.lowStockThreshold,
      variant.isActive,
      ...attributeKeys.map((key) => cell(attributes[key])),
      ...optionKeys.map((key) => cell(options[key])),
      ...locations.map((location) => variant.onHand.get(location.id) ?? 0),
    ];
  });
  return { header, rows };
}

export interface StockExportLevel {
  sku: string;
  productName: string;
  locationName: string;
  onHand: number;
  reserved: number;
}

export function stockExportTable(levels: readonly StockExportLevel[]): ExportTable {
  return {
    header: ['sku', 'product_name', 'location', 'on_hand', 'reserved', 'available'],
    rows: levels.map((level) => [
      level.sku,
      level.productName,
      level.locationName,
      level.onHand,
      level.reserved,
      level.onHand - level.reserved,
    ]),
  };
}

export interface OrderExportRow {
  orderNumber: number;
  createdAt: Date;
  status: string;
  paymentStatus: string | null;
  paymentMethod: string;
  fulfillmentType: string;
  isGuest: boolean;
  units: number;
  subtotal: Prisma.Decimal | null;
  discountTotal: Prisma.Decimal | null;
  shippingTotal: Prisma.Decimal | null;
  taxTotal: Prisma.Decimal | null;
  grandTotal: Prisma.Decimal;
  currency: string;
  shippingZoneName: string | null;
  customer: {
    name: string | null;
    email: string | null;
    phone: string;
    address: Prisma.JsonValue | null;
  };
}

const ADDRESS_PARTS = ['street', 'area', 'city', 'region', 'ghanaPostGps', 'country'];

/** Order totals per order; customer name, email, phone and delivery address only when `withCustomers`. */
export function orderExportTable(orders: readonly OrderExportRow[], withCustomers: boolean): ExportTable {
  const header = [
    'order_number',
    'created_at',
    'status',
    'payment_status',
    'payment_method',
    'fulfillment_type',
    'guest',
    'units',
    'subtotal',
    'discount_total',
    'shipping_total',
    'tax_total',
    'grand_total',
    'currency',
    'delivery_zone',
    ...(withCustomers ? ['customer_name', 'customer_email', 'customer_phone', 'delivery_address'] : []),
  ];
  const rows = orders.map((order) => {
    const address = asObject(order.customer.address);
    return [
      order.orderNumber,
      order.createdAt.toISOString(),
      order.status,
      order.paymentStatus,
      order.paymentMethod,
      order.fulfillmentType,
      order.isGuest,
      order.units,
      money(order.subtotal),
      money(order.discountTotal),
      money(order.shippingTotal),
      money(order.taxTotal),
      money(order.grandTotal),
      order.currency,
      order.shippingZoneName,
      ...(withCustomers
        ? [
            order.customer.name,
            order.customer.email,
            order.customer.phone,
            ADDRESS_PARTS.map((part) => address[part])
              .filter((value) => typeof value === 'string' && value !== '')
              .join(', ') || null,
          ]
        : []),
    ];
  });
  return { header, rows };
}
