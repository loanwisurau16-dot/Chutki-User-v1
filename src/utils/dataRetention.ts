import type { AppNotification, CustomerProfile, OrderRecord } from '../types/bazar';

/**
 * 30 days in milliseconds: 30 days * 24 hours * 60 mins * 60 secs * 1000 ms
 * = 2,592,000,000 ms
 */
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Determines whether a given timestamp is older than 30 days.
 */
export function isTimestampOlderThan30Days(
  timestamp: number | null | undefined,
  nowMs = Date.now()
): boolean {
  if (!timestamp || !Number.isFinite(timestamp)) return false;
  return nowMs - timestamp > THIRTY_DAYS_MS;
}

/**
 * Calculates the exact future date string when an order or data entry will be auto-purged.
 */
export function getAutoPurgeDateLabel(
  createdAt: number | null | undefined,
  retentionDays = 30
): string {
  if (!createdAt || !Number.isFinite(createdAt)) return 'After 30 days';
  const purgeTs = createdAt + retentionDays * 24 * 60 * 60 * 1000;
  return new Date(purgeTs).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Automatically prunes past orders older than 30 days.
 * Active in-flight orders (e.g. PLACED, PREPARING, PACKING, OUT_FOR_DELIVERY) are always kept safe.
 * Completed orders (DELIVERED, CANCELLED) older than 30 days are purged.
 */
export function prune30DayExpiredOrders<T extends { createdAt?: number; placedAt?: number; status?: string }>(
  orders: Record<string, T>,
  nowMs = Date.now()
): {
  retainedOrders: Record<string, T>;
  purgedCount: number;
} {
  const retainedOrders: Record<string, T> = {};
  let purgedCount = 0;

  Object.entries(orders).forEach(([orderId, order]) => {
    const orderTs = Number(order.placedAt || order.createdAt || 0);
    const isCompleted =
      order.status === 'DELIVERED' ||
      order.status === 'CANCELLED';

    const isOlderThan30Days = orderTs > 0 && isTimestampOlderThan30Days(orderTs, nowMs);

    // Keep if within 30 days, or if an order is still active / in-transit
    if (!isOlderThan30Days || !isCompleted) {
      retainedOrders[orderId] = order;
    } else {
      purgedCount += 1;
    }
  });

  return { retainedOrders, purgedCount };
}

/**
 * Automatically prunes notification inbox items older than 30 days.
 */
export function prune30DayExpiredNotifications(
  notifications: AppNotification[],
  nowMs = Date.now()
): {
  retainedNotifications: AppNotification[];
  purgedCount: number;
} {
  const retainedNotifications: AppNotification[] = [];
  let purgedCount = 0;

  notifications.forEach((item) => {
    if (item.createdAt && isTimestampOlderThan30Days(item.createdAt, nowMs)) {
      purgedCount += 1;
    } else {
      retainedNotifications.push(item);
    }
  });

  return { retainedNotifications, purgedCount };
}

export interface AccountDeletionStatus {
  isScheduled: boolean;
  isExpired: boolean;
  daysRemaining: number;
  scheduledPurgeDateStr: string;
}

/**
 * Evaluates whether an account has a 30-day auto-deletion scheduled and whether the 30 days have elapsed.
 */
export function checkAccount30DayAutoDeleteStatus(
  profile?: CustomerProfile | null,
  nowMs = Date.now()
): AccountDeletionStatus {
  const scheduledAt = Number(profile?.deleteScheduledAt || 0);
  if (!scheduledAt || !Number.isFinite(scheduledAt)) {
    return {
      isScheduled: false,
      isExpired: false,
      daysRemaining: 0,
      scheduledPurgeDateStr: '',
    };
  }

  // Scheduled date is scheduledAt + 30 days
  const purgeDeadline = scheduledAt + THIRTY_DAYS_MS;
  const msRemaining = purgeDeadline - nowMs;
  const daysRemaining = Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));
  const isExpired = msRemaining <= 0;

  const scheduledPurgeDateStr = new Date(purgeDeadline).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  return {
    isScheduled: true,
    isExpired,
    daysRemaining,
    scheduledPurgeDateStr,
  };
}

/**
 * Sets the 30-day account deletion schedule timestamp on the profile.
 */
export function scheduleAccount30DayAutoDelete(
  profile: CustomerProfile,
  nowMs = Date.now()
): CustomerProfile {
  return {
    ...profile,
    deleteScheduledAt: nowMs,
    deleteAutoPurgeDays: 30,
    updatedAt: nowMs,
  };
}

/**
 * Cancels a scheduled 30-day account deletion.
 */
export function cancelAccount30DayAutoDelete(
  profile: CustomerProfile,
  nowMs = Date.now()
): CustomerProfile {
  const updated = { ...profile };
  delete updated.deleteScheduledAt;
  delete updated.deleteAutoPurgeDays;
  updated.updatedAt = nowMs;
  return updated;
}
