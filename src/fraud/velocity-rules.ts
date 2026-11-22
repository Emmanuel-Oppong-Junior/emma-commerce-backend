import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { VelocityLevel, VelocityRule } from '../generated/prisma/client';
import { normaliseGhanaPhone } from '../commons/phone/ghana-phone';

export enum VelocityEvent {
  ORDER_PLACED = 'ORDER_PLACED',
  PAYMENT_STARTED = 'PAYMENT_STARTED',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
}

export enum VelocitySubject {
  CUSTOMER = 'CUSTOMER',
  PHONE = 'PHONE',
  IP = 'IP',
  /** The provider's card fingerprint (Paystack authorization signature), known only once a charge is verified. */
  CARD = 'CARD',
}

/** Where a velocity check runs. Placement and initiation can refuse; settlement can only flag. */
export enum VelocityCheckpoint {
  ORDER_PLACEMENT = 'ORDER_PLACEMENT',
  PAYMENT_INITIATION = 'PAYMENT_INITIATION',
  PAYMENT_SETTLEMENT = 'PAYMENT_SETTLEMENT',
}

export interface VelocityRuleDefinition {
  event: VelocityEvent;
  subject: VelocitySubject;
  windowSeconds: number;
  defaultSoftLimit: number;
  defaultHardLimit: number;
}

export interface VelocityLimits {
  softLimit: number;
  hardLimit: number;
}

export type VelocitySubjects = Partial<Record<VelocitySubject, string>>;

export interface VelocityHit {
  rule: VelocityRule;
  level: VelocityLevel;
  count: number;
  limit: number;
}

const HOUR = 3600;
const DAY = 24 * HOUR;

/*
 * Defaults: a shopper rarely places more than a couple of orders an hour, so a few more get a human look and a burst
 * is refused. IP limits are loose because Ghanaian mobile networks put many customers behind one carrier-grade NAT
 * address. Failed payments are the strongest signal (card testing, a stolen MoMo wallet), so they are tightest.
 */
export const VELOCITY_RULES: Record<VelocityRule, VelocityRuleDefinition> = {
  ORDERS_PER_CUSTOMER_1H: rule(VelocityEvent.ORDER_PLACED, VelocitySubject.CUSTOMER, HOUR, 3, 6),
  ORDERS_PER_CUSTOMER_24H: rule(VelocityEvent.ORDER_PLACED, VelocitySubject.CUSTOMER, DAY, 6, 15),
  ORDERS_PER_PHONE_24H: rule(VelocityEvent.ORDER_PLACED, VelocitySubject.PHONE, DAY, 6, 15),
  ORDERS_PER_IP_1H: rule(VelocityEvent.ORDER_PLACED, VelocitySubject.IP, HOUR, 10, 30),
  ORDERS_PER_IP_24H: rule(VelocityEvent.ORDER_PLACED, VelocitySubject.IP, DAY, 40, 120),
  PAYMENT_ATTEMPTS_PER_CUSTOMER_1H: rule(VelocityEvent.PAYMENT_STARTED, VelocitySubject.CUSTOMER, HOUR, 8, 20),
  PAYMENT_ATTEMPTS_PER_IP_1H: rule(VelocityEvent.PAYMENT_STARTED, VelocitySubject.IP, HOUR, 20, 60),
  FAILED_PAYMENTS_PER_CUSTOMER_24H: rule(VelocityEvent.PAYMENT_FAILED, VelocitySubject.CUSTOMER, DAY, 4, 10),
  FAILED_PAYMENTS_PER_CARD_24H: rule(VelocityEvent.PAYMENT_FAILED, VelocitySubject.CARD, DAY, 3, 6),
};

export const ALL_VELOCITY_RULES = Object.keys(VELOCITY_RULES) as VelocityRule[];

const REDIS_KEY_PREFIX = 'velocity';
const MAX_LIMIT = 1_000_000;

function rule(
  event: VelocityEvent,
  subject: VelocitySubject,
  windowSeconds: number,
  defaultSoftLimit: number,
  defaultHardLimit: number,
): VelocityRuleDefinition {
  return { event, subject, windowSeconds, defaultSoftLimit, defaultHardLimit };
}

/** A rule checked at a checkpoint, and whether the event being checked counts towards it (it has not happened yet). */
export interface CheckedRule {
  rule: VelocityRule;
  includesPendingEvent: boolean;
}

/**
 * The rules each checkpoint evaluates for the subjects it knows. Placement and initiation count the order or attempt
 * about to happen; initiation also reads the customer's failed payments so far; settlement reads failed payments
 * after the failure (if any) was recorded.
 */
export function rulesAt(checkpoint: VelocityCheckpoint, subjects: VelocitySubjects): CheckedRule[] {
  return ALL_VELOCITY_RULES.flatMap((name): CheckedRule[] => {
    const { event, subject } = VELOCITY_RULES[name];
    if (!subjects[subject]) return [];
    switch (checkpoint) {
      case VelocityCheckpoint.ORDER_PLACEMENT:
        return event === VelocityEvent.ORDER_PLACED ? [{ rule: name, includesPendingEvent: true }] : [];
      case VelocityCheckpoint.PAYMENT_INITIATION:
        if (event === VelocityEvent.PAYMENT_STARTED) return [{ rule: name, includesPendingEvent: true }];
        return event === VelocityEvent.PAYMENT_FAILED && subject === VelocitySubject.CUSTOMER
          ? [{ rule: name, includesPendingEvent: false }]
          : [];
      case VelocityCheckpoint.PAYMENT_SETTLEMENT:
        return event === VelocityEvent.PAYMENT_FAILED ? [{ rule: name, includesPendingEvent: false }] : [];
    }
  });
}

/** The rules counting `event` for the subjects given, i.e. the counters to increment once the event happened. */
export function rulesCounting(event: VelocityEvent, subjects: VelocitySubjects): VelocityRule[] {
  return ALL_VELOCITY_RULES.filter(
    (name) => VELOCITY_RULES[name].event === event && subjects[VELOCITY_RULES[name].subject],
  );
}

/** The rules whose count went above a limit: HARD above the hard limit, else SOFT above the soft limit. */
export function evaluateVelocity(
  counts: ReadonlyMap<VelocityRule, number>,
  limits: Record<VelocityRule, VelocityLimits>,
): VelocityHit[] {
  return [...counts].flatMap(([name, count]): VelocityHit[] => {
    const { softLimit, hardLimit } = limits[name];
    if (count > hardLimit) return [{ rule: name, level: VelocityLevel.HARD, count, limit: hardLimit }];
    if (count > softLimit) return [{ rule: name, level: VelocityLevel.SOFT, count, limit: softLimit }];
    return [];
  });
}

/** The code defaults with the store's overrides applied. */
export function effectiveLimits(
  overrides: readonly ({ rule: VelocityRule } & VelocityLimits)[],
): Record<VelocityRule, VelocityLimits> {
  const limits = Object.fromEntries(
    ALL_VELOCITY_RULES.map((name) => [
      name,
      { softLimit: VELOCITY_RULES[name].defaultSoftLimit, hardLimit: VELOCITY_RULES[name].defaultHardLimit },
    ]),
  ) as Record<VelocityRule, VelocityLimits>;
  for (const { rule: name, softLimit, hardLimit } of overrides) limits[name] = { softLimit, hardLimit };
  return limits;
}

/** Refuses a limits update that names a rule twice or has a non-positive limit or a hard limit below the soft one. */
export function assertValidLimits(updates: readonly ({ rule: VelocityRule } & VelocityLimits)[]): void {
  const seen = new Set<VelocityRule>();
  for (const { rule: name, softLimit, hardLimit } of updates) {
    if (seen.has(name)) throw new BadRequestException(`Velocity rule ${name} is listed more than once`);
    seen.add(name);
    for (const [field, value] of [
      ['softLimit', softLimit],
      ['hardLimit', hardLimit],
    ] as const) {
      if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
        throw new BadRequestException(`${name}: ${field} must be a whole number from 1 to ${MAX_LIMIT}, got ${value}`);
      }
    }
    if (hardLimit < softLimit) {
      throw new BadRequestException(`${name}: hardLimit (${hardLimit}) must be at least softLimit (${softLimit})`);
    }
  }
}

/**
 * The Redis counter key of a rule for one subject. The subject is SHA-256 hashed with its type, so no phone number, IP
 * address or card fingerprint is stored in Redis.
 */
export function velocityCounterKey(name: VelocityRule, subjects: VelocitySubjects): string {
  const subject = VELOCITY_RULES[name].subject;
  const value = subjects[subject];
  if (!value) throw new Error(`Velocity rule ${name} needs a ${subject} subject`);
  const digest = createHash('sha256').update(`${subject}:${value}`).digest('hex');
  return `${REDIS_KEY_PREFIX}:${name}:${digest}`;
}

/** The subjects of a request in their counted form; blank values are left out. */
export function velocitySubjects(raw: {
  customerId?: string;
  phone?: string;
  ip?: string;
  card?: string;
}): VelocitySubjects {
  const subjects: VelocitySubjects = {};
  if (raw.customerId) subjects[VelocitySubject.CUSTOMER] = raw.customerId;
  const phone = raw.phone ? normalisePhoneSubject(raw.phone) : '';
  if (phone) subjects[VelocitySubject.PHONE] = phone;
  const ip = raw.ip ? normaliseIpSubject(raw.ip) : '';
  if (ip) subjects[VelocitySubject.IP] = ip;
  if (raw.card) subjects[VelocitySubject.CARD] = raw.card;
  return subjects;
}

/** One form per phone number: Ghana numbers in E.164, any other number by its digits. */
export function normalisePhoneSubject(phone: string): string {
  return normaliseGhanaPhone(phone) ?? phone.replace(/\D/g, '');
}

/** IPv4 clients reach a dual-stack server as IPv4-mapped IPv6 (::ffff:1.2.3.4); count them as the IPv4 address. */
export function normaliseIpSubject(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  return trimmed.startsWith('::ffff:') && trimmed.includes('.') ? trimmed.slice('::ffff:'.length) : trimmed;
}
