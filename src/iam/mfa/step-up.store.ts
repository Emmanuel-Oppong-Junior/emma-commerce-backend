import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

/** How long an MFA verification lets a session perform sensitive actions (ADR-0013 step-up). */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

/** True while `verifiedAtMs` is less than the step-up window before `nowMs`. */
export function isStepUpFresh(verifiedAtMs: number | null, nowMs: number): boolean {
  return verifiedAtMs !== null && nowMs >= verifiedAtMs && nowMs - verifiedAtMs < STEP_UP_WINDOW_MS;
}

/** Per-session record of the last MFA verification, in Redis so every API instance sees it; it expires with the window. */
@Injectable()
export class StepUpStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async markVerified(userId: string, sessionId: string, verifiedAtMs: number): Promise<void> {
    await this.redis.set(this.key(userId, sessionId), String(verifiedAtMs), 'PX', STEP_UP_WINDOW_MS);
  }

  async lastVerifiedAt(userId: string, sessionId: string): Promise<number | null> {
    const value = await this.redis.get(this.key(userId, sessionId));
    return value === null ? null : Number(value);
  }

  private key(userId: string, sessionId: string): string {
    return `mfa:step-up:${userId}:${sessionId}`;
  }
}
