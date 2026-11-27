import test from 'node:test';
import assert from 'node:assert/strict';
import { getCanonicalOrderIdForGroup, isRiderCommunicationEligible } from './riderComm';
import type { GroupedOrder, OrderRecord } from '../types/bazar';

function createMockGroup(overrides: Partial<GroupedOrder> = {}): GroupedOrder {
  return {
    groupKey: 'grp_default',
    orders: [],
    createdAt: Date.now(),
    deliveryOtp: '1234',
    paymentMode: 'COD',
    phone: '9876543210',
    address: 'Station Road, Gossaigaon',
    totalAmount: 100,
    deliveryUid: null,
    riderLat: null,
    riderLng: null,
    customerLat: null,
    customerLng: null,
    locationLink: '',
    emergencyAlert: false,
    emergencyDetails: '',
    ...overrides,
  };
}

function createMockOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    orderId: 'ord_default',
    customerUid: 'u1',
    restaurantId: 's1',
    items: [],
    totalAmount: 100,
    status: 'PLACED',
    createdAt: Date.now(),
    ...overrides,
  };
}

test('getCanonicalOrderIdForGroup returns canonicalOrderId, first sub-order ID, or groupKey', () => {
  const groupWithCanonical = createMockGroup({
    groupKey: 'grp_123',
    canonicalOrderId: 'ord_main_1',
    orders: [createMockOrder({ orderId: 'sub_1', status: 'OUT_FOR_DELIVERY' })],
  });
  assert.equal(getCanonicalOrderIdForGroup(groupWithCanonical), 'ord_main_1');

  const groupWithoutCanonical = createMockGroup({
    groupKey: 'grp_456',
    canonicalOrderId: undefined,
    orders: [createMockOrder({ orderId: 'sub_first', status: 'OUT_FOR_DELIVERY' })],
  });
  assert.equal(getCanonicalOrderIdForGroup(groupWithoutCanonical), 'sub_first');

  const emptyGroup = createMockGroup({
    groupKey: 'grp_empty',
    canonicalOrderId: undefined,
    orders: [],
  });
  assert.equal(getCanonicalOrderIdForGroup(emptyGroup), 'grp_empty');
});

test('isRiderCommunicationEligible checks assigned rider and active status', () => {
  // No rider assigned
  const noRiderGroup = createMockGroup({
    groupKey: 'grp_1',
    deliveryUid: null,
    orders: [createMockOrder({ orderId: 'o1', status: 'PLACED' })],
  });
  assert.equal(isRiderCommunicationEligible(noRiderGroup), false);

  // Rider assigned and order active (out for delivery)
  const activeRiderGroup = createMockGroup({
    groupKey: 'grp_2',
    deliveryUid: 'rider_01',
    orders: [createMockOrder({ orderId: 'o2', deliveryUid: 'rider_01', status: 'OUT_FOR_DELIVERY' })],
  });
  assert.equal(isRiderCommunicationEligible(activeRiderGroup), true);

  // Rider assigned but order delivered
  const deliveredGroup = createMockGroup({
    groupKey: 'grp_3',
    deliveryUid: 'rider_01',
    orders: [createMockOrder({ orderId: 'o3', deliveryUid: 'rider_01', status: 'DELIVERED' })],
  });
  assert.equal(isRiderCommunicationEligible(deliveredGroup), false);

  // Rider assigned but order cancelled
  const cancelledGroup = createMockGroup({
    groupKey: 'grp_4',
    deliveryUid: 'rider_01',
    orders: [createMockOrder({ orderId: 'o4', deliveryUid: 'rider_01', status: 'CANCELLED' })],
  });
  assert.equal(isRiderCommunicationEligible(cancelledGroup), false);
});
