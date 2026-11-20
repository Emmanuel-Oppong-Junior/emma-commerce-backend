import { JobsOptions } from 'bullmq';

/**
 * Emails queued directly by the API, outside any business transaction (sign-up, verification, password reset).
 * Emails that follow a state change go through the outbox instead (src/outbox/domain-events.ts).
 */
export interface EmailJobData {
  'email.welcome.v1': { to: string; name: string };
  'email.verification.v1': { to: string; verificationToken: string; expiresInHours: number };
  'email.change_requested.v1': { to: string; newEmail: string };
  'email.password_reset.v1': { to: string; resetToken: string };
}

export type EmailJobName = keyof EmailJobData;

const DAY_SECONDS = 24 * 60 * 60;

/** Token-bearing jobs leave Redis once sent, and soon after a final failure (the tokens expire within a day). */
export const TOKEN_EMAIL_JOB_OPTIONS: JobsOptions = { removeOnComplete: true, removeOnFail: { age: 2 * DAY_SECONDS } };
