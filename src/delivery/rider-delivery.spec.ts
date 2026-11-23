import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { amountToCollect, dayRange, RiderDeliveryRow, toRiderDelivery } from './rider-delivery';

const row = (overrides: Partial<RiderDeliveryRow['order']> = {}): RiderDeliveryRow => ({
  id: 'ship1',
  status: 'OUT_FOR_DELIVERY',
  assignedAt: new Date('2026-11-23T08:00:00Z'),
  dispatchedAt: new Date('2026-11-23T09:00:00Z'),
  deliveredAt: null,
  order: {
    orderNumber: 1042,
    paymentMethod: 'CASH_ON_DELIVERY',
    grandTotal: new Prisma.Decimal('120.50'),
    contactPhone: '+233244000001',
    shippingAddressSnapshot: {
      recipientName: 'Ama Mensah',
      phone: '+233201112222',
      street: '12 Oxford St',
      area: 'Osu',
      city: 'Accra',
      region: 'GREATER_ACCRA',
      landmark: 'Opposite the bank',
      ghanaPostGps: 'GA-123-4567',
      latitude: 5.556,
      longitude: -0.1969,
      country: 'GH',
    },
    paymentIntent: null,
    ...overrides,
  },
  items: [{ quantity: 2, orderItem: { productName: 'Kente scarf', sku: 'KS-1' } }],
});

describe('rider delivery view', () => {
  it('carries only what the delivery needs: recipient, address, items and the cash to collect', () => {
    expect(toRiderDelivery(row())).toEqual({
      shipmentId: 'ship1',
      status: 'OUT_FOR_DELIVERY',
      orderNumber: 1042,
      recipientName: 'Ama Mensah',
      recipientPhone: '+233201112222',
      address: {
        street: '12 Oxford St',
        area: 'Osu',
        city: 'Accra',
        region: 'GREATER_ACCRA',
        landmark: 'Opposite the bank',
        ghanaPostGps: 'GA-123-4567',
        latitude: 5.556,
        longitude: -0.1969,
      },
      items: [{ productName: 'Kente scarf', sku: 'KS-1', quantity: 2 }],
      amountToCollect: new Prisma.Decimal('120.50'),
      assignedAt: new Date('2026-11-23T08:00:00Z'),
      dispatchedAt: new Date('2026-11-23T09:00:00Z'),
      deliveredAt: null,
    });
  });

  it('falls back to the order contact phone when the address has none', () => {
    const view = toRiderDelivery(row({ shippingAddressSnapshot: { street: 'x', phone: '' } }));
    expect(view.recipientPhone).toBe('+233244000001');
    expect(view.recipientName).toBeNull();
  });

  describe('amountToCollect', () => {
    const total = new Prisma.Decimal('99.00');

    it('is the order total for unpaid cash on delivery', () => {
      expect(amountToCollect('CASH_ON_DELIVERY', total, null)).toEqual(total);
      expect(amountToCollect('CASH_ON_DELIVERY', total, 'PENDING')).toEqual(total);
    });

    it('is nothing for an online order or cash already recorded', () => {
      expect(amountToCollect('ONLINE', total, 'CAPTURED')).toBeNull();
      expect(amountToCollect('CASH_ON_DELIVERY', total, 'CAPTURED')).toBeNull();
    });
  });

  describe('dayRange', () => {
    it('is the UTC day', () => {
      expect(dayRange('2026-11-23')).toEqual({
        from: new Date('2026-11-23T00:00:00Z'),
        to: new Date('2026-11-24T00:00:00Z'),
      });
    });

    it.each(['2026-02-30', '2026-13-01'])('refuses %s', (date) => {
      expect(() => dayRange(date)).toThrow(BadRequestException);
    });
  });
});
