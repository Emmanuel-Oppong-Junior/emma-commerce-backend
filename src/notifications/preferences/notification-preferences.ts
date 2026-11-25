import { NotificationCategory, NotificationChannel } from '../../generated/prisma/client';

/** The channels each category can reach a customer on (marketing never goes to the in-app feed). */
export const CATEGORY_CHANNELS: Record<NotificationCategory, readonly NotificationChannel[]> = {
  [NotificationCategory.TRANSACTIONAL]: [
    NotificationChannel.EMAIL,
    NotificationChannel.SMS,
    NotificationChannel.IN_APP,
  ],
  [NotificationCategory.MARKETING]: [NotificationChannel.EMAIL, NotificationChannel.SMS],
};

export interface StoredPreference {
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
}

export interface PreferenceView extends StoredPreference {
  /** True for transactional messages, which cannot be switched off. */
  locked: boolean;
}

/** Every category and channel with its current choice: transactional always on, marketing off until consented. */
export function preferenceMatrix(stored: readonly StoredPreference[]): PreferenceView[] {
  return (Object.keys(CATEGORY_CHANNELS) as NotificationCategory[]).flatMap((category) =>
    CATEGORY_CHANNELS[category].map((channel) => {
      const locked = category === NotificationCategory.TRANSACTIONAL;
      const row = stored.find((pref) => pref.category === category && pref.channel === channel);
      return { category, channel, locked, enabled: locked || (row?.enabled ?? false) };
    }),
  );
}

export type PreferenceRefusal = 'TRANSACTIONAL_ALWAYS_ON' | 'CHANNEL_NOT_AVAILABLE' | 'PHONE_NOT_VERIFIED';

/** Why a customer may not set this choice, or null. SMS marketing needs a verified phone (ADR-0015). */
export function preferenceRefusal(
  category: NotificationCategory,
  channel: NotificationChannel,
  enabled: boolean,
  phoneVerified: boolean,
): PreferenceRefusal | null {
  if (!CATEGORY_CHANNELS[category].includes(channel)) return 'CHANNEL_NOT_AVAILABLE';
  if (category === NotificationCategory.TRANSACTIONAL) return enabled ? null : 'TRANSACTIONAL_ALWAYS_ON';
  if (enabled && channel === NotificationChannel.SMS && !phoneVerified) return 'PHONE_NOT_VERIFIED';
  return null;
}

/**
 * Whether a message may go out now (checked at send time: consent may have been withdrawn since it was queued).
 * Transactional always; marketing only with the customer's consent for the channel, and for SMS a verified phone.
 */
export function mayDeliver(
  category: NotificationCategory,
  channel: NotificationChannel,
  marketingConsent: boolean,
  phoneVerified: boolean,
): boolean {
  if (category === NotificationCategory.TRANSACTIONAL) return true;
  if (!CATEGORY_CHANNELS[category].includes(channel) || !marketingConsent) return false;
  return channel !== NotificationChannel.SMS || phoneVerified;
}
