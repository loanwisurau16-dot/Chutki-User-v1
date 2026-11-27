import type { GroupedOrder } from '../types/bazar';
import { deriveGroupOrderStatus } from './bazarLogic';

/**
 * Returns a canonical single order ID to represent a grouped multi-store order.
 * Prefers group.canonicalOrderId or the first sub-order's orderId, falling back to groupKey.
 */
export function getCanonicalOrderIdForGroup(group: GroupedOrder): string {
  if (group.canonicalOrderId) return group.canonicalOrderId;
  if (Array.isArray(group.orders) && group.orders.length > 0 && group.orders[0]?.orderId) {
    return group.orders[0].orderId;
  }
  return group.groupKey;
}

/**
 * Determines whether in-app rider communication (call or chat) is eligible.
 * Eligible only if an active rider is assigned and the order is still active (not all delivered or cancelled).
 */
export function isRiderCommunicationEligible(group: GroupedOrder): boolean {
  if (!group || !group.deliveryUid) return false;
  const status = deriveGroupOrderStatus(group);
  return !status.isAllDelivered && !status.isAllCancelled;
}
