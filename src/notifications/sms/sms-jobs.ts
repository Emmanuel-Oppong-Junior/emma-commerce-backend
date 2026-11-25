import { JobsOptions } from 'bullmq';
import { ShipmentStatus } from '../../generated/prisma/client';
import { DirectNotificationRef } from '../email-jobs';
import { ReadyForPickupNotice } from '../templates/templates';

/** SMS jobs on the notifications queue. */
export interface SmsJobData {
  'sms.phone_otp.v1': DirectNotificationRef & { to: string; code: string; expiresInMinutes: number };
  /** A shipment milestone (P5-B.2); ids only, the recipient and text are read when sending. */
  'sms.shipment_milestone.v1': { orderId: string; shipmentId: string; status: ShipmentStatus };
  /** `userId` (the order's customer) was added in P6-N.1; absent on older jobs. */
  'sms.ready_for_pickup.v1': { to: string; notice: ReadyForPickupNotice; userId?: string };
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
