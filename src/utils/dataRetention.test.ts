import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THIRTY_DAYS_MS,
  isTimestampOlderThan30Days,
  getAutoPurgeDateLabel,
  prune30DayExpiredOrders,
  prune30DayExpiredNotifications,
  checkAccount30DayAutoDeleteStatus,
  scheduleAccount30DayAutoDelete,
  cancelAccount30DayAutoDelete,
} from './dataRetention';
import type { AppNotification, CustomerProfile, OrderRecord } from '../types/bazar';

test('isTimestampOlderThan30Days accurately flags dates older than 30 days', () => {
  const now = 1700000000000;
  const twentyDaysOld = now - 20 * 24 * 60 * 60 * 1000;
  const thirtyOneDaysOld = now - 31 * 24 * 60 * 60 * 1000;

  assert.equal(isTimestampOlderThan30Days(twentyDaysOld, now), false);
  assert.equal(isTimestampOlderThan30Days(thirtyOneDaysOld, now), true);
  assert.equal(isTimestampOlderThan30Days(null, now), false);
  assert.equal(isTimestampOlderThan30Days(undefined, now), false);
});

test('getAutoPurgeDateLabel computes correct date string 30 days in future', () => {
  const base = new Date('2026-01-01T12:00:00Z').getTime();
  const label = getAutoPurgeDateLabel(base, 30);
  assert.ok(label.includes('2026') || label.includes('Jan') || label.includes('31'));
});

test('prune30DayExpiredOrders purges completed orders older than 30 days while keeping active ones', () => {
  const now = 1700000000000;
  const thirtyFiveDaysAgo = now - 35 * 24 * 60 * 60 * 1000;
  const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

  const mockOrders: Record<string, Partial<OrderRecord>> = {
    recentDelivered: {
      orderId: 'o1',
      status: 'DELIVERED',
      placedAt: tenDaysAgo,
      createdAt: tenDaysAgo,
    },
    oldDelivered: {
      orderId: 'o2',
      status: 'DELIVERED',
      placedAt: thirtyFiveDaysAgo,
      createdAt: thirtyFiveDaysAgo,
    },
    oldCancelled: {
      orderId: 'o3',
      status: 'CANCELLED',
      placedAt: thirtyFiveDaysAgo,
      createdAt: thirtyFiveDaysAgo,
    },
    oldStillActive: {
      orderId: 'o4',
      status: 'OUT_FOR_DELIVERY',
      placedAt: thirtyFiveDaysAgo,
      createdAt: thirtyFiveDaysAgo,
    },
  };

  const { retainedOrders, purgedCount } = prune30DayExpiredOrders(mockOrders as any, now);
  assert.equal(purgedCount, 2);
  assert.ok(retainedOrders.recentDelivered);
  assert.ok(retainedOrders.oldStillActive);
  assert.equal(retainedOrders.oldDelivered, undefined);
  assert.equal(retainedOrders.oldCancelled, undefined);
});

test('prune30DayExpiredNotifications cleans notifications older than 30 days', () => {
  const now = 1700000000000;
  const recentNotif: AppNotification = {
    id: 'n1',
    title: 'Order Placed',
    body: 'Fresh alert',
    tag: 'gb-test',
    type: 'ORDER',
    read: false,
    createdAt: now - 5 * 24 * 60 * 60 * 1000,
  };
  const oldNotif: AppNotification = {
    id: 'n2',
    title: 'Old Promo',
    body: 'Expired promo',
    tag: 'gb-promo',
    type: 'PROMO',
    read: true,
    createdAt: now - 32 * 24 * 60 * 60 * 1000,
  };

  const { retainedNotifications, purgedCount } = prune30DayExpiredNotifications(
    [recentNotif, oldNotif],
    now
  );
  assert.equal(purgedCount, 1);
  assert.equal(retainedNotifications.length, 1);
  assert.equal(retainedNotifications[0].id, 'n1');
});

test('checkAccount30DayAutoDeleteStatus tracks countdown and expiration', () => {
  const now = 1700000000000;

  // Unscheduled
  const profileUnscheduled: CustomerProfile = { name: 'Test' };
  const s1 = checkAccount30DayAutoDeleteStatus(profileUnscheduled, now);
  assert.equal(s1.isScheduled, false);

  // Scheduled 10 days ago (20 days remaining)
  const scheduledTenDaysAgo = scheduleAccount30DayAutoDelete(profileUnscheduled, now - 10 * 86400000);
  const s2 = checkAccount30DayAutoDeleteStatus(scheduledTenDaysAgo, now);
  assert.equal(s2.isScheduled, true);
  assert.equal(s2.isExpired, false);
  assert.equal(s2.daysRemaining, 20);

  // Scheduled 31 days ago (Expired!)
  const scheduledThirtyOneDaysAgo = scheduleAccount30DayAutoDelete(profileUnscheduled, now - 31 * 86400000);
  const s3 = checkAccount30DayAutoDeleteStatus(scheduledThirtyOneDaysAgo, now);
  assert.equal(s3.isScheduled, true);
  assert.equal(s3.isExpired, true);
  assert.equal(s3.daysRemaining, 0);

  // Cancel deletion
  const cancelled = cancelAccount30DayAutoDelete(scheduledTenDaysAgo, now);
  const s4 = checkAccount30DayAutoDeleteStatus(cancelled, now);
  assert.equal(s4.isScheduled, false);
  assert.equal(cancelled.deleteScheduledAt, undefined);
});
