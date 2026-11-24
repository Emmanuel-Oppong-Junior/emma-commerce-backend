import { ShipmentStatus } from '../../generated/prisma/client';
import { SHIPMENT_SMS_STATUSES, shipmentSmsRecipient } from './shipment-sms';

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

describe('SHIPMENT_SMS_STATUSES', () => {
  it('covers dispatch and delivery only (the pickup counter is the pickup flow’s)', () => {
    expect(SHIPMENT_SMS_STATUSES).toEqual([ShipmentStatus.OUT_FOR_DELIVERY, ShipmentStatus.DELIVERED]);
  });
});
