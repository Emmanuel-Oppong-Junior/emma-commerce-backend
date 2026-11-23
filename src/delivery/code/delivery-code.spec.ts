import {
  deliveryCode,
  deliveryCodeDispatch,
  deliveryCodeKey,
  deliveryCodeKeys,
  hashDeliveryCode,
  normaliseDeliveryCode,
  withDeliveryCode,
} from './delivery-code';

const keys = deliveryCodeKeys(Buffer.alloc(32, 7));
const at = new Date('2026-11-23T09:00:00Z');

describe('delivery codes', () => {
  it('derives six digits, the same for a dispatch every time and different for the next dispatch or shipment', () => {
    const code = deliveryCode(keys.codeKey, 'ship1', at);
    expect(code).toMatch(/^\d{6}$/);
    expect(deliveryCode(keys.codeKey, 'ship1', new Date(at))).toBe(code);
    const others = [
      deliveryCode(keys.codeKey, 'ship1', new Date(at.getTime() + 1)),
      deliveryCode(keys.codeKey, 'ship2', at),
      deliveryCode(deliveryCodeKeys(Buffer.alloc(32, 8)).codeKey, 'ship1', at),
    ];
    expect(others.filter((other) => other === code).length).toBeLessThanOrEqual(1);
  });

  it('hashes the code bound to its shipment and dispatch with a separate key, and keeps ids out of Redis keys', () => {
    const hash = hashDeliveryCode(keys.hashKey, 'ship1', at, '123456');
    expect(hash).not.toContain('123456');
    expect(hashDeliveryCode(keys.hashKey, 'ship2', at, '123456')).not.toBe(hash);
    expect(hashDeliveryCode(keys.hashKey, 'ship1', new Date(at.getTime() + 1), '123456')).not.toBe(hash);
    expect(keys.hashKey.equals(keys.codeKey)).toBe(false);
    expect(deliveryCodeKey('ship1')).toMatch(/^delivery-code:[0-9a-f]{64}$/);
  });

  it('is sent only for a rider’s shipment still out for delivery', () => {
    expect(deliveryCodeDispatch({ status: 'OUT_FOR_DELIVERY', riderId: 'r1', dispatchedAt: at })).toBe(at);
    expect(deliveryCodeDispatch({ status: 'OUT_FOR_DELIVERY', riderId: null, dispatchedAt: at })).toBeNull();
    expect(deliveryCodeDispatch({ status: 'DELIVERED', riderId: 'r1', dispatchedAt: at })).toBeNull();
  });

  it('rides along in the milestone text and accepts a code typed with spaces', () => {
    expect(withDeliveryCode('Your order #5 is out for delivery.', '004211')).toBe(
      'Your order #5 is out for delivery. Give the rider this code when you receive it: 004211.',
    );
    expect(normaliseDeliveryCode(' 004 211 ')).toBe('004211');
  });
});
