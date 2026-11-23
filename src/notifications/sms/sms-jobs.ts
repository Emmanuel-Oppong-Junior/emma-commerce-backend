import { JobsOptions } from 'bullmq';
import type { ReadyForPickupEmail as ReadyForPickup } from '../email/templates/email.templates';

/** SMS jobs on the notifications queue. */
export interface SmsJobData {
  'sms.phone_otp.v1': { to: string; code: string; expiresInMinutes: number };
  'sms.ready_for_pickup.v1': { to: string; notice: ReadyForPickup };
}

export type SmsJobName = keyof SmsJobData;

// The code is dead within minutes, so the job (phone number and code) leaves Redis once sent and an hour after a final
// failure; retries beyond that would only deliver an expired code.
export const PHONE_OTP_JOB_OPTIONS: JobsOptions = {
  attempts: 4,
  removeOnComplete: true,
  removeOnFail: { age: 60 * 60 },
};

// A pickup notice is still useful days later, so it keeps the queue's default retries; it leaves Redis once sent.
export const READY_FOR_PICKUP_SMS_JOB_OPTIONS: JobsOptions = { removeOnComplete: true };

/** The ready-for-pickup SMS: order number, where, and when the point is open. */
export function readyForPickupText(notice: ReadyForPickup): string {
  return `Order #${notice.orderNumber} is ready for pickup at ${notice.pickupName}, ${notice.address}. Open: ${notice.hours}.`;
}

/** The OTP SMS, within one 160-character GSM-7 segment. */
export function phoneOtpText(code: string, expiresInMinutes: number): string {
  return `${code} is your verification code. It expires in ${expiresInMinutes} minutes. Never share it with anyone.`;
}
