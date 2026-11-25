import { JobsOptions } from 'bullmq';

/**
 * Who a directly queued message is for: the account, and the key of the Notification row written when it was queued.
 * Absent on jobs queued before P6-N.1 (the worker then finds the account by address and keys the row on the job id).
 */
export interface DirectNotificationRef {
  userId?: string;
  dedupeKey?: string;
}

/**
 * Emails queued directly by the API, outside any business transaction (sign-up, verification, password reset).
 * Emails that follow a state change go through the outbox instead (src/outbox/domain-events.ts).
 */
export interface EmailJobData {
  'email.welcome.v1': DirectNotificationRef & { to: string; name: string };
  'email.verification.v1': DirectNotificationRef & { to: string; verificationToken: string; expiresInHours: number };
  'email.change_requested.v1': DirectNotificationRef & { to: string; newEmail: string };
  'email.password_reset.v1': DirectNotificationRef & { to: string; resetToken: string };
}

export type EmailJobName = keyof EmailJobData;

const DAY_SECONDS = 24 * 60 * 60;

/** Token-bearing jobs leave Redis once sent, and soon after a final failure (the tokens expire within a day). */
export const TOKEN_EMAIL_JOB_OPTIONS: JobsOptions = { removeOnComplete: true, removeOnFail: { age: 2 * DAY_SECONDS } };
