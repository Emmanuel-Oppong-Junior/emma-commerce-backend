import { ForbiddenException, Injectable } from '@nestjs/common';
import { OrderReviewFlag, Prisma, VelocityLevel, VelocityLimit, VelocityRule } from '../generated/prisma/client';
import { AuditService, fieldValues } from '../commons/audit.service';
import { LoggerService } from '../commons/logger.service';
import { describeErrorForLog } from '../commons/filters/error-classification';
import { AppMetrics } from '../observability/metrics';
import { VelocityCounter } from './velocity-counter';
import { FlaggedOrderRecord, VelocityRepository } from './velocity.repository';
import {
  ALL_VELOCITY_RULES,
  assertValidLimits,
  effectiveLimits,
  evaluateVelocity,
  rulesAt,
  rulesCounting,
  VELOCITY_RULES,
  velocityCounterKey,
  VelocityCheckpoint,
  VelocityEvent,
  VelocityHit,
  VelocityLimits,
  VelocityRuleDefinition,
  VelocitySubjects,
} from './velocity-rules';

export const VELOCITY_LIMIT = 'VELOCITY_LIMIT';

const CONTEXT = 'Velocity';

const REFUSALS: Record<VelocityCheckpoint, string> = {
  [VelocityCheckpoint.ORDER_PLACEMENT]:
    'Too many orders in a short time from this account, phone number or network. Try again later or contact the store.',
  [VelocityCheckpoint.PAYMENT_INITIATION]:
    'Too many payment attempts in a short time from this account or network. Try again later or contact the store.',
  [VelocityCheckpoint.PAYMENT_SETTLEMENT]: 'Payment settlement is never refused',
  [VelocityCheckpoint.REFERRAL_SIGNUP]:
    'This referral code has been used too many times today. Try again tomorrow or contact the store.',
};

export interface VelocityLimitView extends VelocityRuleDefinition, VelocityLimits {
  rule: VelocityRule;
  /** False once the store has set its own limits for the rule. */
  isDefault: boolean;
}

/**
 * Velocity checks (P3-E.1). Counters live in Redis and the limits in the database. When Redis cannot be reached the
 * check lets the action through (fail-open) with an error log and metric: Redis is required at startup, so an outage
 * mid-flight is short, and refusing every checkout during it would cost more than the few orders it lets past.
 */
@Injectable()
export class VelocityService {
  constructor(
    private readonly counter: VelocityCounter,
    private readonly repository: VelocityRepository,
    private readonly auditService: AuditService,
    private readonly logger: LoggerService,
    private readonly metrics: AppMetrics,
  ) {}

  /**
   * Checks the rules of a placement or initiation checkpoint. FORBIDDEN with reason VELOCITY_LIMIT when a hard limit is
   * exceeded; otherwise returns the soft hits, which the caller flags on the order.
   */
  async screenOrRefuse(checkpoint: VelocityCheckpoint, subjects: VelocitySubjects): Promise<VelocityHit[]> {
    const hits = await this.screen(checkpoint, subjects);
    if (hits.some((hit) => hit.level === VelocityLevel.HARD)) {
      throw new ForbiddenException({ message: REFUSALS[checkpoint], extensions: { reason: VELOCITY_LIMIT } });
    }
    return hits;
  }

  /** The rules of the checkpoint whose count is above a limit. Never throws: a counter failure means no hits. */
  async screen(checkpoint: VelocityCheckpoint, subjects: VelocitySubjects): Promise<VelocityHit[]> {
    const checked = rulesAt(checkpoint, subjects);
    if (checked.length === 0) return [];
    let hits: VelocityHit[];
    try {
      const [overrides, current] = await Promise.all([
        this.repository.findLimits(),
        this.counter.read(checked.map(({ rule }) => velocityCounterKey(rule, subjects))),
      ]);
      const counts = new Map(
        checked.map(({ rule, includesPendingEvent }, index) => [rule, current[index] + (includesPendingEvent ? 1 : 0)]),
      );
      hits = evaluateVelocity(counts, effectiveLimits(overrides));
    } catch (error) {
      this.metrics.recordVelocityCheckError('screen');
      this.logger.error(
        `Velocity check skipped (fail-open) | checkpoint: ${checkpoint}`,
        describeErrorForLog(error),
        CONTEXT,
      );
      return [];
    }
    for (const hit of hits) {
      this.metrics.recordVelocityLimitHit(hit.rule, hit.level);
      this.logger.warn(
        `Velocity limit exceeded | checkpoint: ${checkpoint} | rule: ${hit.rule} | level: ${hit.level} | count: ${hit.count} | limit: ${hit.limit}`,
        CONTEXT,
      );
    }
    return hits;
  }

  /** Counts an event that happened. Never throws: the action has already taken place, so a failure is only logged. */
  async record(event: VelocityEvent, subjects: VelocitySubjects): Promise<void> {
    const rules = rulesCounting(event, subjects);
    try {
      await this.counter.increment(
        rules.map((rule) => ({
          key: velocityCounterKey(rule, subjects),
          windowSeconds: VELOCITY_RULES[rule].windowSeconds,
        })),
      );
    } catch (error) {
      this.metrics.recordVelocityCheckError('record');
      this.logger.error(`Velocity event not counted | event: ${event}`, describeErrorForLog(error), CONTEXT);
    }
  }

  /** Flags the order for every hit; a rule already flagged on it and not yet cleared is not flagged twice. */
  async flagOrder(orderId: string, hits: readonly VelocityHit[], tx?: Prisma.TransactionClient): Promise<void> {
    const flagged = await this.repository.flagOrder(orderId, hits, tx);
    if (flagged > 0) {
      this.logger.warn(
        `Order flagged for review | orderId: ${orderId} | rules: ${hits.map((hit) => hit.rule).join(',')}`,
        CONTEXT,
      );
    }
  }

  async getLimits(): Promise<VelocityLimitView[]> {
    return this.viewOf(await this.repository.findLimits());
  }

  async updateLimits(
    updates: readonly ({ rule: VelocityRule } & VelocityLimits)[],
    actorId: string,
  ): Promise<VelocityLimitView[]> {
    assertValidLimits(updates);
    await this.auditService.record(
      async (tx) => {
        const before = effectiveLimits(await this.repository.findLimits(tx));
        const storeId = await this.repository.upsertLimits(tx, updates, actorId);
        return { storeId, before, after: effectiveLimits(await this.repository.findLimits(tx)) };
      },
      ({ storeId, before, after }) => ({
        entity: 'VelocityLimit',
        entityId: storeId,
        action: 'UPDATE',
        userId: actorId,
        details: {
          changes: Object.fromEntries(
            updates.map(({ rule }) => [
              rule,
              {
                from: fieldValues(before[rule], ['softLimit', 'hardLimit']),
                to: fieldValues(after[rule], ['softLimit', 'hardLimit']),
              },
            ]),
          ),
        },
      }),
    );
    return this.getLimits();
  }

  async flaggedOrders(take: number): Promise<FlaggedOrderRecord[]> {
    return this.repository.findFlaggedOrders(take);
  }

  async clearFlags(orderId: string, note: string, actorId: string): Promise<OrderReviewFlag[]> {
    return this.auditService.record(
      (tx) => this.repository.clearFlags(tx, orderId, actorId, note),
      (cleared) => ({
        entity: 'Order',
        entityId: orderId,
        action: 'UPDATE',
        userId: actorId,
        details: {
          reviewFlagsCleared: cleared.map(({ id, rule, level }) => ({ id, rule, level })),
          note,
        },
      }),
    );
  }

  private viewOf(overrides: VelocityLimit[]): VelocityLimitView[] {
    const limits = effectiveLimits(overrides);
    const overridden = new Set(overrides.map(({ rule }) => rule));
    return ALL_VELOCITY_RULES.map((rule) => ({
      rule,
      ...VELOCITY_RULES[rule],
      ...limits[rule],
      isDefault: !overridden.has(rule),
    }));
  }
}
