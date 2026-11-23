import { ShipmentStatus } from '../../generated/prisma/client';
import { SHIPMENT_SMS_STATUSES, shipmentSmsRecipient, shipmentSmsText } from './shipment-sms';

describe('shipmentSmsRecipient', () => {
  it('prefers the verified phone, then the delivery address phone, then the contact phone', () => {
    expect(
      shipmentSmsRecipient({ verifiedPhone: '+233201111111', addressPhone: '0242222222', contactPhone: '0243333333' }),
    ).toBe('+233201111111');
    expect(
      shipmentSmsRecipient({ verifiedPhone: null, addressPhone: '024 222 2222', contactPhone: '0243333333' }),
    ).toBe('+233242222222');
    expect(shipmentSmsRecipient({ verifiedPhone: null, addressPhone: null, contactPhone: '233243333333' })).toBe(
      '+233243333333',
    );
  });

  it('skips numbers that are not Ghanaian and gives null when none is usable', () => {
    expect(
      shipmentSmsRecipient({ verifiedPhone: null, addressPhone: '+447700900123', contactPhone: '0243333333' }),
    ).toBe('+233243333333');
    expect(shipmentSmsRecipient({ verifiedPhone: null, addressPhone: null, contactPhone: '+15550100' })).toBeNull();
  });
});

describe('shipmentSmsText', () => {
  it('names the carrier and tracking number when set', () => {
    expect(
      shipmentSmsText({
        orderNumber: 1042,
        status: ShipmentStatus.OUT_FOR_DELIVERY,
        carrier: 'DHL',
        trackingNumber: 'T1',
      }),
    ).toBe('Your order #1042 is out for delivery with DHL. Tracking number: T1.');
    expect(
      shipmentSmsText({
        orderNumber: 1042,
        status: ShipmentStatus.OUT_FOR_DELIVERY,
        carrier: null,
        trackingNumber: null,
      }),
    ).toBe('Your order #1042 is out for delivery.');
    expect(
      shipmentSmsText({ orderNumber: 1042, status: ShipmentStatus.DELIVERED, carrier: 'DHL', trackingNumber: 'T1' }),
    ).toBe('Your order #1042 has been delivered. Thank you for shopping with us.');
  });

  it('covers dispatch and delivery only (the pickup counter is the pickup flow’s)', () => {
    expect(SHIPMENT_SMS_STATUSES).toEqual([ShipmentStatus.OUT_FOR_DELIVERY, ShipmentStatus.DELIVERED]);
  });
});
