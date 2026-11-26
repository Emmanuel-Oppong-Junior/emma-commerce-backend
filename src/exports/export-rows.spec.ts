import { Prisma } from '../generated/prisma/client';
import { orderExportTable, productExportTable, stockExportTable } from './export-rows';

const D = (value: string) => new Prisma.Decimal(value);

describe('export tables', () => {
  it('lists one row per variant with attribute, option and per-location stock columns', () => {
    const product = {
      id: 'p1',
      name: '=Tee',
      status: 'PUBLISHED',
      isTaxable: true,
      attributes: { material: 'Cotton' },
      productType: 'apparel',
      category: 'Clothes',
      subcategory: null,
      brand: null,
      tags: ['New', 'Sale'],
    };
    const table = productExportTable(
      [
        {
          sku: 'TEE-S',
          barcode: null,
          basePrice: D('100'),
          price: D('115'),
          weightGrams: 200,
          lowStockThreshold: 5,
          isActive: true,
          optionValues: { size: 'S' },
          onHand: new Map([['loc_main', 7]]),
          product,
        },
      ],
      [
        { id: 'loc_main', name: 'Main' },
        { id: 'loc_shop', name: 'Shop' },
      ],
    );

    expect(table.header).toEqual([
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
      'attr.material',
      'option.size',
      'on_hand.Main',
      'on_hand.Shop',
    ]);
    expect(table.rows[0]).toEqual([
      'TEE-S',
      'p1',
      '=Tee',
      'apparel',
      'Clothes',
      null,
      null,
      'New|Sale',
      'PUBLISHED',
      true,
      null,
      '100.00',
      '115.00',
      200,
      5,
      true,
      'Cotton',
      'S',
      7,
      0,
    ]);
  });

  it('computes available stock per level', () => {
    expect(
      stockExportTable([{ sku: 'A', productName: 'Apple', locationName: 'Main', onHand: 5, reserved: 2 }]).rows,
    ).toEqual([['A', 'Apple', 'Main', 5, 2, 3]]);
  });

  it('adds customer columns only when asked', () => {
    const order = {
      orderNumber: 1001,
      createdAt: new Date('2026-11-20T10:00:00.000Z'),
      status: 'COMPLETED',
      paymentStatus: 'CAPTURED',
      paymentMethod: 'ONLINE',
      fulfillmentType: 'DELIVERY',
      isGuest: true,
      units: 3,
      subtotal: D('90'),
      discountTotal: D('0'),
      shippingTotal: D('10'),
      taxTotal: D('11.74'),
      grandTotal: D('100'),
      currency: 'GHS',
      shippingZoneName: 'Accra',
      customer: {
        name: 'Ama',
        email: null,
        phone: '+233200000000',
        address: { street: '1 Ring Rd', city: 'Accra', region: 'GREATER_ACCRA', area: null },
      },
    };

    const plain = orderExportTable([order], false);
    const full = orderExportTable([order], true);

    expect(plain.header).not.toContain('customer_phone');
    expect(plain.rows[0]).toEqual([
      1001,
      '2026-11-20T10:00:00.000Z',
      'COMPLETED',
      'CAPTURED',
      'ONLINE',
      'DELIVERY',
      true,
      3,
      '90.00',
      '0.00',
      '10.00',
      '11.74',
      '100.00',
      'GHS',
      'Accra',
    ]);
    expect(full.rows[0].slice(-4)).toEqual(['Ama', null, '+233200000000', '1 Ring Rd, Accra, GREATER_ACCRA']);
  });
});
