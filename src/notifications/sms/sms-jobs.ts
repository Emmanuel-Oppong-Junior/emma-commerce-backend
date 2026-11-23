import { JobsOptions } from 'bullmq';
import { ShipmentStatus } from '../../generated/prisma/client';

/** SMS jobs on the notifications queue. */
export interface SmsJobData {
  'sms.phone_otp.v1': { to: string; code: string; expiresInMinutes: number };
  /** A shipment milestone (P5-B.2); ids only, the recipient and text are read when sending. */
  'sms.shipment_milestone.v1': { orderId: string; shipmentId: string; status: ShipmentStatus };
}

export type SmsJobName = keyof SmsJobData;

// The code is dead within minutes, so the job (phone number and code) leaves Redis once sent and an hour after a final
// failure; retries beyond that would only deliver an expired code.
export const PHONE_OTP_JOB_OPTIONS: JobsOptions = {
  attempts: 4,
  removeOnComplete: true,
  removeOnFail: { age: 60 * 60 },
};

/** The OTP SMS, within one 160-character GSM-7 segment. */
export function phoneOtpText(code: string, expiresInMinutes: number): string {
  return `${code} is your verification code. It expires in ${expiresInMinutes} minutes. Never share it with anyone.`;
}
