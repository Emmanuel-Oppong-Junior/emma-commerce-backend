import { BadRequestException } from '@nestjs/common';
import { VelocityLevel, VelocityRule } from '../generated/prisma/client';
import {
  ALL_VELOCITY_RULES,
  assertValidLimits,
  effectiveLimits,
  evaluateVelocity,
  normaliseIpSubject,
  rulesAt,
  rulesCounting,
  VELOCITY_RULES,
  velocityCounterKey,
  VelocityCheckpoint,
  VelocityEvent,
  velocitySubjects,
} from './velocity-rules';

describe('velocity rules', () => {
  const all = velocitySubjects({
    customerId: 'user-1',
    phone: '024 412 3456',
    ip: '::ffff:41.66.1.2',
    card: 'SIG_abc',
    referrerId: 'referrer-1',
  });

  describe('subjects', () => {
    it('normalises the phone to E.164 and an IPv4-mapped address to IPv4', () => {
      expect(all).toEqual({
        CUSTOMER: 'user-1',
        PHONE: '+233244123456',
        IP: '41.66.1.2',
        CARD: 'SIG_abc',
        REFERRER: 'referrer-1',
      });
    });

    it('leaves out blank subjects and keeps a real IPv6 address as it is', () => {
      expect(velocitySubjects({ customerId: 'user-1', phone: '', ip: undefined })).toEqual({ CUSTOMER: 'user-1' });
      expect(normaliseIpSubject('2001:DB8::1')).toBe('2001:db8::1');
    });
  });

  describe('counter keys', () => {
    it('hashes the subject with its type so no phone, IP or card appears in the key', () => {
      const keys = ALL_VELOCITY_RULES.map((rule) => velocityCounterKey(rule, all));

      for (const key of keys) {
        expect(key).toMatch(/^velocity:[A-Z0-9_]+:[0-9a-f]{64}$/);
        for (const raw of ['233244123456', '0244123456', '41.66.1.2', 'SIG_abc', 'user-1', 'referrer-1']) {
          expect(key).not.toContain(raw);
        }
      }
    });

    it('gives each rule and each subject its own counter, and the same subject the same counter', () => {
      const other = velocitySubjects({ customerId: 'user-2', ip: '41.66.1.2' });

      expect(velocityCounterKey('ORDERS_PER_CUSTOMER_1H', all)).not.toBe(
        velocityCounterKey('ORDERS_PER_CUSTOMER_24H', all),
      );
      expect(velocityCounterKey('ORDERS_PER_CUSTOMER_1H', all)).not.toBe(
        velocityCounterKey('ORDERS_PER_CUSTOMER_1H', other),
      );
      expect(velocityCounterKey('ORDERS_PER_IP_1H', all)).toBe(velocityCounterKey('ORDERS_PER_IP_1H', other));
    });

    it('keys a value by its subject type, so a customer id equal to a phone does not share its counter', () => {
      const asCustomer = velocitySubjects({ customerId: '+233244123456' });
      const digest = (key: string) => key.split(':')[2];

      expect(digest(velocityCounterKey('ORDERS_PER_CUSTOMER_24H', asCustomer))).not.toBe(
        digest(velocityCounterKey('ORDERS_PER_PHONE_24H', all)),
      );
    });

    it('refuses a rule whose subject is missing', () => {
      expect(() => velocityCounterKey('FAILED_PAYMENTS_PER_CARD_24H', { CUSTOMER: 'user-1' })).toThrow('CARD');
    });
  });

  describe('windows', () => {
    it('counts each rule over a one-hour or one-day window', () => {
      expect(VELOCITY_RULES.ORDERS_PER_CUSTOMER_1H.windowSeconds).toBe(3600);
      expect(VELOCITY_RULES.ORDERS_PER_IP_24H.windowSeconds).toBe(86400);
      expect(ALL_VELOCITY_RULES.every((rule) => [3600, 86400].includes(VELOCITY_RULES[rule].windowSeconds))).toBe(true);
    });
  });

  describe('rulesAt and rulesCounting', () => {
    it('checks the order rules at placement, counting the order about to be placed', () => {
      expect(rulesAt(VelocityCheckpoint.ORDER_PLACEMENT, all)).toEqual([
        { rule: 'ORDERS_PER_CUSTOMER_1H', includesPendingEvent: true },
        { rule: 'ORDERS_PER_CUSTOMER_24H', includesPendingEvent: true },
        { rule: 'ORDERS_PER_PHONE_24H', includesPendingEvent: true },
        { rule: 'ORDERS_PER_IP_1H', includesPendingEvent: true },
        { rule: 'ORDERS_PER_IP_24H', includesPendingEvent: true },
      ]);
    });

    it("checks attempts (with the new one) and the customer's failures so far at initiation", () => {
      expect(rulesAt(VelocityCheckpoint.PAYMENT_INITIATION, all)).toEqual([
        { rule: 'PAYMENT_ATTEMPTS_PER_CUSTOMER_1H', includesPendingEvent: true },
        { rule: 'PAYMENT_ATTEMPTS_PER_IP_1H', includesPendingEvent: true },
        { rule: 'FAILED_PAYMENTS_PER_CUSTOMER_24H', includesPendingEvent: false },
      ]);
    });

    it('checks customer and card failures at settlement, and only rules whose subject is known', () => {
      expect(rulesAt(VelocityCheckpoint.PAYMENT_SETTLEMENT, all)).toEqual([
        { rule: 'FAILED_PAYMENTS_PER_CUSTOMER_24H', includesPendingEvent: false },
        { rule: 'FAILED_PAYMENTS_PER_CARD_24H', includesPendingEvent: false },
      ]);
      expect(rulesAt(VelocityCheckpoint.ORDER_PLACEMENT, { CUSTOMER: 'user-1' }).map(({ rule }) => rule)).toEqual([
        'ORDERS_PER_CUSTOMER_1H',
        'ORDERS_PER_CUSTOMER_24H',
      ]);
    });

    it('checks referral sign-ups per referrer, counting the one being entered (P6-L.2)', () => {
      expect(rulesAt(VelocityCheckpoint.REFERRAL_SIGNUP, all)).toEqual([
        { rule: 'REFERRALS_PER_REFERRER_24H', includesPendingEvent: true },
      ]);
      expect(rulesCounting(VelocityEvent.REFERRAL_SIGNUP, all)).toEqual(['REFERRALS_PER_REFERRER_24H']);
      expect(rulesAt(VelocityCheckpoint.ORDER_PLACEMENT, all).map(({ rule }) => rule)).not.toContain(
        'REFERRALS_PER_REFERRER_24H',
      );
    });

    it('increments the counters of the event for the subjects given', () => {
      expect(rulesCounting(VelocityEvent.PAYMENT_FAILED, { CUSTOMER: 'user-1' })).toEqual([
        'FAILED_PAYMENTS_PER_CUSTOMER_24H',
      ]);
      expect(rulesCounting(VelocityEvent.PAYMENT_STARTED, all)).toEqual([
        'PAYMENT_ATTEMPTS_PER_CUSTOMER_1H',
        'PAYMENT_ATTEMPTS_PER_IP_1H',
      ]);
    });
  });

  describe('evaluateVelocity', () => {
    const limits = effectiveLimits([{ rule: 'ORDERS_PER_CUSTOMER_1H', softLimit: 2, hardLimit: 4 }]);
    const evaluate = (count: number) =>
      evaluateVelocity(new Map([['ORDERS_PER_CUSTOMER_1H' as VelocityRule, count]]), limits);

    it('lets a count at or below the soft limit through', () => {
      expect(evaluate(1)).toEqual([]);
      expect(evaluate(2)).toEqual([]);
    });

    it('is SOFT above the soft limit up to the hard limit', () => {
      expect(evaluate(3)).toEqual([{ rule: 'ORDERS_PER_CUSTOMER_1H', level: VelocityLevel.SOFT, count: 3, limit: 2 }]);
      expect(evaluate(4)).toEqual([{ rule: 'ORDERS_PER_CUSTOMER_1H', level: VelocityLevel.SOFT, count: 4, limit: 2 }]);
    });

    it('is HARD above the hard limit, reported once at that level', () => {
      expect(evaluate(5)).toEqual([{ rule: 'ORDERS_PER_CUSTOMER_1H', level: VelocityLevel.HARD, count: 5, limit: 4 }]);
    });

    it('evaluates every rule independently', () => {
      const hits = evaluateVelocity(
        new Map<VelocityRule, number>([
          ['ORDERS_PER_CUSTOMER_1H', 3],
          ['ORDERS_PER_IP_1H', 31],
          ['ORDERS_PER_PHONE_24H', 1],
        ]),
        limits,
      );

      expect(hits.map(({ rule, level }) => [rule, level])).toEqual([
        ['ORDERS_PER_CUSTOMER_1H', 'SOFT'],
        ['ORDERS_PER_IP_1H', 'HARD'],
      ]);
    });
  });

  describe('limits', () => {
    it('uses the code defaults for rules the store has not overridden', () => {
      const limits = effectiveLimits([{ rule: 'ORDERS_PER_IP_1H', softLimit: 50, hardLimit: 80 }]);

      expect(limits.ORDERS_PER_IP_1H).toEqual({ softLimit: 50, hardLimit: 80 });
      expect(limits.ORDERS_PER_CUSTOMER_1H).toEqual({ softLimit: 3, hardLimit: 6 });
      expect(Object.keys(limits)).toHaveLength(ALL_VELOCITY_RULES.length);
    });

    it('has defaults that would pass validation', () => {
      expect(() =>
        assertValidLimits(ALL_VELOCITY_RULES.map((rule) => ({ rule, ...effectiveLimits([])[rule] }))),
      ).not.toThrow();
    });

    it('accepts a hard limit equal to the soft one', () => {
      expect(() => assertValidLimits([{ rule: 'ORDERS_PER_IP_1H', softLimit: 5, hardLimit: 5 }])).not.toThrow();
    });

    it.each([
      [{ softLimit: 5, hardLimit: 4 }, 'hardLimit (4) must be at least softLimit (5)'],
      [{ softLimit: 0, hardLimit: 4 }, 'softLimit must be a whole number from 1'],
      [{ softLimit: 2, hardLimit: -1 }, 'hardLimit must be a whole number from 1'],
      [{ softLimit: 1.5, hardLimit: 4 }, 'softLimit must be a whole number from 1'],
      [{ softLimit: 1, hardLimit: 2_000_000 }, 'hardLimit must be a whole number from 1 to 1000000'],
    ])('refuses %p', (values, message) => {
      const attempt = () => assertValidLimits([{ rule: 'ORDERS_PER_IP_1H', ...values }]);

      expect(attempt).toThrow(BadRequestException);
      expect(attempt).toThrow(message);
    });

    it('refuses the same rule twice', () => {
      expect(() =>
        assertValidLimits([
          { rule: 'ORDERS_PER_IP_1H', softLimit: 1, hardLimit: 2 },
          { rule: 'ORDERS_PER_IP_1H', softLimit: 3, hardLimit: 4 },
        ]),
      ).toThrow('listed more than once');
    });
  });
});
