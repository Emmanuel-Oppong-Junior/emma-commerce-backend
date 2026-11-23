import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { parseMfaKey } from '../../iam/mfa/mfa-crypto';
import {
  DELIVERY_CODE_MAX_ATTEMPTS,
  DELIVERY_CODE_TTL_SECONDS,
  deliveryCode,
  deliveryCodeKey,
  DeliveryCodeKeys,
  deliveryCodeKeys,
  hashDeliveryCode,
  normaliseDeliveryCode,
} from './delivery-code';

/*
 * KEYS: code. ARGV: dispatch (ms), code hash, TTL ms.
 * Keeps a code already stored for the same dispatch (a retried job must not reset its attempts or lock); any other
 * dispatch replaces it. Returns 1 when stored, 0 when kept.
 */
const ISSUE_SCRIPT = `
if redis.call('HGET', KEYS[1], 'dispatch') == ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'dispatch', ARGV[1], 'hash', ARGV[2], 'attempts', 0, 'locked', 0)
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

/*
 * KEYS: code. ARGV: dispatch (ms), hash of the code entered, attempts allowed.
 * Returns {0, 0} on a match (kept: the delivery may still fail to commit), {1, 0} when no code was issued for this
 * dispatch, {2, 0} when the code is locked (this entry may have used the last attempt), else {3, attempts left}.
 */
const VERIFY_SCRIPT = `
if redis.call('HGET', KEYS[1], 'dispatch') ~= ARGV[1] then return {1, 0} end
if redis.call('HGET', KEYS[1], 'locked') == '1' then return {2, 0} end
if redis.call('HGET', KEYS[1], 'hash') == ARGV[2] then return {0, 0} end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if attempts >= tonumber(ARGV[3]) then
  redis.call('HSET', KEYS[1], 'locked', 1)
  return {2, 0}
end
return {3, tonumber(ARGV[3]) - attempts}
`;

export type DeliveryCodeCheck =
  { result: 'MATCH' } | { result: 'NOT_ISSUED' } | { result: 'LOCKED' } | { result: 'MISMATCH'; attemptsLeft: number };

/**
 * Delivery codes (P5-C.2): six digits texted to the customer when a rider takes the shipment out, given to the rider
 * at the door. Redis holds only the code's keyed hash per shipment and dispatch, with its wrong-entry count; after
 * DELIVERY_CODE_MAX_ATTEMPTS wrong entries the code locks until the next dispatch.
 */
@Injectable()
export class DeliveryCodes {
  private readonly keys: DeliveryCodeKeys;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.keys = deliveryCodeKeys(parseMfaKey(config.getOrThrow<string>('MFA_ENCRYPTION_KEY')));
  }

  /** The code of this dispatch, stored (once per dispatch) so it can be checked. */
  async issue(shipmentId: string, dispatchedAt: Date): Promise<string> {
    const code = deliveryCode(this.keys.codeKey, shipmentId, dispatchedAt);
    await this.redis.eval(
      ISSUE_SCRIPT,
      1,
      deliveryCodeKey(shipmentId),
      String(dispatchedAt.getTime()),
      hashDeliveryCode(this.keys.hashKey, shipmentId, dispatchedAt, code),
      DELIVERY_CODE_TTL_SECONDS * 1000,
    );
    return code;
  }

  async check(shipmentId: string, dispatchedAt: Date, entered: string): Promise<DeliveryCodeCheck> {
    const hash = hashDeliveryCode(this.keys.hashKey, shipmentId, dispatchedAt, normaliseDeliveryCode(entered));
    const [status, attemptsLeft] = (await this.redis.eval(
      VERIFY_SCRIPT,
      1,
      deliveryCodeKey(shipmentId),
      String(dispatchedAt.getTime()),
      hash,
      DELIVERY_CODE_MAX_ATTEMPTS,
    )) as [number, number];
    switch (status) {
      case 0:
        return { result: 'MATCH' };
      case 1:
        return { result: 'NOT_ISSUED' };
      case 2:
        return { result: 'LOCKED' };
      case 3:
        return { result: 'MISMATCH', attemptsLeft };
      default:
        throw new Error(`Unexpected delivery code check status ${status}`);
    }
  }
}
