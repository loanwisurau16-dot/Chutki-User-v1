import React, { useEffect, useState } from 'react';
import type { DeliveryPartner, GroupedOrder, OrderRecord, Store } from '../types/bazar';
import {
  buildOrderStatusTimeline,
  calculateDistanceKm,
  computeDeliveryCountdown,
  deriveGroupOrderStatus,
  filterPastOrdersByQuery,
  getActiveOrderGroups,
  getPastOrdersFromCache,
  normalizeOrderStatus,
  type OrderFilterSegment,
} from '../utils/bazarLogic';
import {
  buildOrderReceiptFromGroup,
  buildOrderReceiptFromOrder,
} from '../utils/orderReceipt';
import { OrderReceiptCard } from './OrderReceiptCard';
import { DeliveryQrCard } from './DeliveryQrCard';
import { RiderMiniMap, type StoreMarkerInfo } from './RiderMiniMap';
import { triggerHaptic } from '../utils/haptics';
import {
  getCanonicalOrderIdForGroup,
  isRiderCommunicationEligible,
} from '../utils/riderComm';
import { sanitizeSafeUrl } from '../utils/security';
import { getAutoPurgeDateLabel } from '../utils/dataRetention';

interface OrdersTabProps {
  groupedOrders: GroupedOrder[];
  cachedOrders: Record<string, Omit<OrderRecord, 'orderId'>>;
  stores: Record<string, Store>;
  deliveryPartners: Record<string, DeliveryPartner>;
  timelineTimestamps?: Record<string, Record<string, number>>;
  gmpQuotaExceeded: boolean;
  brandName?: string;
  allowRiderTip?: boolean;
  allowRefundRequests?: boolean;
  allowDeliveryQr?: boolean;
  allowRiderVoiceCall?: boolean;
  allowRiderChat?: boolean;
  unreadChatCounts?: Record<string, number>;
  onOpenTipRider: (groupKey: string) => void;
  onOpenRefundOrder: (order: OrderRecord) => void;
  onOpenCancelOrder: (groupKey: string) => void;
  onReorderOrder: (order: OrderRecord) => void;
  onCallRider?: (group: GroupedOrder) => void;
  onMessageRider?: (group: GroupedOrder) => void;
}

export const OrdersTab: React.FC<OrdersTabProps> = ({
  groupedOrders = [],
  cachedOrders = {},
  stores = {},
  deliveryPartners = {},
  timelineTimestamps = {},
  gmpQuotaExceeded,
  brandName,
  allowRiderTip = true,
  allowRefundRequests = true,
  allowDeliveryQr = true,
  allowRiderVoiceCall = true,
  allowRiderChat = true,
  unreadChatCounts = {},
  onOpenTipRider,
  onOpenRefundOrder,
  onOpenCancelOrder,
  onReorderOrder,
  onCallRider,
  onMessageRider,
}) => {
  const [orderFilter, setOrderFilter] = useState<OrderFilterSegment>('ACTIVE');
  const [pastSearchQuery, setPastSearchQuery] = useState<string>('');
  const [openReceiptId, setOpenReceiptId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const safeGroupedOrders = (groupedOrders || []).filter((g) => g && g.groupKey);
  const activeGroups = getActiveOrderGroups(safeGroupedOrders);
  const deliveredOrders = getPastOrdersFromCache(cachedOrders || {}, 'DELIVERED');
  const cancelledOrders = getPastOrdersFromCache(cachedOrders || {}, 'CANCELLED');
  const basePastOrders =
    orderFilter === 'DELIVERED' ? deliveredOrders : cancelledOrders;
  const filteredPastOrders = filterPastOrdersByQuery(
    basePastOrders,
    pastSearchQuery,
    stores
  );
  const totalPastCount = deliveredOrders.length + cancelledOrders.length;

  const hasLiveTimerGroups = activeGroups.some((g) => {
    const d = deriveGroupOrderStatus(g);
    return !d.isAllDelivered && !d.isAllCancelled;
  });

  useEffect(() => {
    if (!hasLiveTimerGroups) return undefined;
    setNowMs(Date.now());
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [hasLiveTimerGroups]);

  return (
    <div id="tab-orders" className="tab-content active">
      <div className="orders-header-row">
        <h2 className="orders-main-title">
          {orderFilter === 'ACTIVE'
            ? 'Live Orders & Delivery PIN'
            : orderFilter === 'DELIVERED'
              ? 'Delivered Past Orders'
              : 'Cancelled Past Orders'}
        </h2>
      </div>

      <div
        className="orders-filter-bar"
        role="tablist"
        aria-label="Filter orders by status"
        data-testid="orders-filter-bar"
      >
        <button
          type="button"
          role="tab"
          aria-selected={orderFilter === 'ACTIVE'}
          className={`orders-filter-tab ${orderFilter === 'ACTIVE' ? 'active' : ''}`}
          onClick={() => {
            if (orderFilter !== 'ACTIVE') triggerHaptic('tap');
            setOrderFilter('ACTIVE');
          }}
        >
          Active <span className="orders-filter-count">({activeGroups.length})</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={orderFilter === 'DELIVERED'}
          className={`orders-filter-tab ${orderFilter === 'DELIVERED' ? 'active' : ''}`}
          onClick={() => {
            if (orderFilter !== 'DELIVERED') triggerHaptic('tap');
            setOrderFilter('DELIVERED');
          }}
        >
          Delivered <span className="orders-filter-count">({deliveredOrders.length})</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={orderFilter === 'CANCELLED'}
          className={`orders-filter-tab ${orderFilter === 'CANCELLED' ? 'active' : ''}`}
          onClick={() => {
            if (orderFilter !== 'CANCELLED') triggerHaptic('tap');
            setOrderFilter('CANCELLED');
          }}
        >
          Cancelled <span className="orders-filter-count">({cancelledOrders.length})</span>
        </button>
      </div>

      {orderFilter === 'ACTIVE' ? (
        <div id="orders-container">
          {activeGroups.length === 0 ? (
            <div className="orders-empty-card" data-testid="orders-empty-active">
              <p className="orders-empty-text">
                {totalPastCount === 0
                  ? 'No orders placed yet.'
                  : 'No active orders right now.'}
              </p>
              {totalPastCount > 0 && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  style={{
                    borderColor: 'var(--brand-green)',
                    color: 'var(--brand-green)',
                    marginTop: '0.6rem',
                  }}
                  onClick={() => {
                    triggerHaptic('tap');
                    setOrderFilter(
                      deliveredOrders.length > 0 ? 'DELIVERED' : 'CANCELLED'
                    );
                  }}
                >
                  View Past Orders ({totalPastCount})
                </button>
              )}
            </div>
          ) : (
            activeGroups.map((group) => {
              const isMultiStore = (group.orders || []).length > 1;
              const rider = group.deliveryUid
                ? deliveryPartners[group.deliveryUid]
                : null;
              const derived = deriveGroupOrderStatus(group);
              const liveRiderLat = group.riderLat || rider?.lat || null;
              const liveRiderLng = group.riderLng || rider?.lng || null;
              const riderDist =
                liveRiderLat && liveRiderLng && group.customerLat
                  ? calculateDistanceKm(
                      liveRiderLat,
                      liveRiderLng,
                      group.customerLat,
                      group.customerLng
                    )
                  : null;

              const seenStores: Record<string, boolean> = {};
              const storeMarkers: StoreMarkerInfo[] = [];
              (group.orders || []).forEach((o, idx) => {
                if (!o || !o.restaurantId || seenStores[o.restaurantId]) return;
                seenStores[o.restaurantId] = true;
                const st = stores[o.restaurantId];
                if (
                  st &&
                  typeof st.lat === 'number' &&
                  typeof st.lng === 'number'
                ) {
                  storeMarkers.push({
                    storeId: o.restaurantId,
                    name: st.name || `Store ${idx + 1}`,
                    lat: st.lat,
                    lng: st.lng,
                  });
                }
              });

              const safeGroupKey = String(group.groupKey || 'ORDER');

              return (
                <div key={safeGroupKey} className="order-card">
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      borderBottom: '1px dashed var(--border)',
                      paddingBottom: '0.5rem',
                      marginBottom: '0.5rem',
                    }}
                  >
                    <div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          flexWrap: 'wrap',
                        }}
                      >
                        <strong style={{ fontSize: '0.95rem' }}>
                          #{safeGroupKey.slice(-6)}
                        </strong>
                        {isMultiStore && (
                          <span
                            style={{
                              background: 'rgba(168,85,247,0.15)',
                              color: '#9333ea',
                              fontSize: '0.65rem',
                              fontWeight: 900,
                              padding: '2px 7px',
                              borderRadius: '6px',
                            }}
                          >
                            {(group.orders || []).length} STORES
                          </span>
                        )}
                        {group.deliverySlot && group.deliverySlot !== 'EXPRESS_15' && (
                          <span className="order-slot-pill">
                            📅 {group.deliverySlot}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
                        {new Date(group.createdAt || Date.now()).toLocaleTimeString()}
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: '0.72rem',
                        fontWeight: 900,
                        background: 'var(--brand-green-light)',
                        color: 'var(--brand-green)',
                        padding: '3px 8px',
                        borderRadius: '10px',
                      }}
                    >
                      {derived.status}
                    </span>
                  </div>

                  {!derived.isAllDelivered && !derived.isAllCancelled && (() => {
                    const countdown = computeDeliveryCountdown(
                      group.placedAt || group.createdAt,
                      nowMs
                    );
                    return (
                      <div
                        className={`order-countdown-card ${
                          countdown.isOverdue || countdown.isFinalStretch ? 'urgent' : ''
                        }`}
                      >
                        <div className="order-countdown-row">
                          <div className="order-countdown-info">
                            <div className="order-countdown-icon">
                              <i className="fa-solid fa-stopwatch" />
                            </div>
                            <div>
                              <div className="order-countdown-title">
                                {countdown.isOverdue
                                  ? 'Delivery ETA Reached'
                                  : 'Est. Delivery Time'}
                              </div>
                              <div className="order-countdown-sub">
                                {countdown.label}
                              </div>
                            </div>
                          </div>
                          <div className="order-countdown-clock">
                            {countdown.formattedRemaining}
                          </div>
                        </div>
                        <div className="order-countdown-track">
                          <div
                            className="order-countdown-fill"
                            style={{ width: `${countdown.progressPercent}%` }}
                          />
                        </div>
                      </div>
                    );
                  })()}

                  {!derived.isAllCancelled ? (
                    <div className="order-stepper">
                      <div
                        className="stepper-progress-fill"
                        style={{ width: derived.stepProgressWidth }}
                      />
                      <div className="step-node active">
                        <div className="step-circle">
                          <i className="fa-solid fa-receipt" />
                        </div>
                        <span>Placed</span>
                      </div>
                      <div className={`step-node ${derived.s2 ? 'active' : ''}`}>
                        <div className="step-circle">
                          <i className="fa-solid fa-box-open" />
                        </div>
                        <span>Packing</span>
                      </div>
                      <div className={`step-node ${derived.s3 ? 'active' : ''}`}>
                        <div className="step-circle">
                          <i className="fa-solid fa-motorcycle" />
                        </div>
                        <span>On the way</span>
                      </div>
                      <div className={`step-node ${derived.s4 ? 'active' : ''}`}>
                        <div className="step-circle">
                          <i className="fa-solid fa-house-chimney" />
                        </div>
                        <span>Delivered</span>
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        background: '#fef2f2',
                        border: '1px solid #fecaca',
                        borderRadius: '12px',
                        padding: '0.7rem',
                        margin: '0.75rem 0',
                        color: 'var(--danger)',
                        fontSize: '0.82rem',
                        fontWeight: 700,
                      }}
                    >
                      <i className="fa-solid fa-ban" /> Order Cancelled
                    </div>
                  )}

                  {!derived.isAllDelivered &&
                    !derived.isAllCancelled &&
                    group.deliveryOtp && (
                      <DeliveryQrCard
                        group={group}
                        allowDeliveryQr={allowDeliveryQr}
                      />
                    )}

                  <div style={{ margin: '0.65rem 0' }}>
                    {(group.orders || []).map((o, idx) => {
                      if (!o) return null;
                      const storeName =
                        stores[o.restaurantId]?.name || `Store ${idx + 1}`;
                      const raw = Array.isArray(o.items)
                        ? o.items
                        : Object.values(o.items || {});
                      return (
                        <div
                          key={o.orderId || idx}
                          style={{
                            background: '#f8fafc',
                            border: '1px solid var(--border)',
                            borderRadius: '10px',
                            padding: '0.55rem 0.75rem',
                            marginBottom: '6px',
                          }}
                        >
                          <div
                            style={{
                              fontSize: '0.74rem',
                              fontWeight: 800,
                              color: 'var(--brand-green)',
                            }}
                          >
                            <i className="fa-solid fa-store" /> {storeName}
                          </div>
                          <div style={{ fontSize: '0.78rem', color: '#475569' }}>
                            {raw.map((i) => i ? `${i.name || 'Item'} × ${i.qty || 1}` : '').filter(Boolean).join(', ')}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontWeight: 900,
                      fontSize: '0.95rem',
                      margin: '6px 0',
                      borderTop: '1px dashed var(--border)',
                      paddingTop: '6px',
                    }}
                  >
                    <span>Total ({group.paymentMode || 'COD'}):</span>
                    <span style={{ color: 'var(--brand-green)' }}>
                      ₹{Number(group.totalAmount || 0).toFixed(0)}
                    </span>
                  </div>

                  <div className="order-receipt-toggle-row">
                    <button
                      type="button"
                      className={`btn btn-outline btn-sm order-receipt-toggle-btn ${
                        openReceiptId === safeGroupKey ? 'active' : ''
                      }`}
                      onClick={() => {
                        triggerHaptic('tap');
                        setOpenReceiptId((prev) =>
                          prev === safeGroupKey ? null : safeGroupKey
                        );
                      }}
                    >
                      <i className="fa-solid fa-file-invoice" />{' '}
                      {openReceiptId === safeGroupKey
                        ? 'Hide Order Receipt'
                        : 'Order Receipt & PDF'}
                    </button>
                  </div>

                  {openReceiptId === safeGroupKey && (
                    <OrderReceiptCard
                      receipt={buildOrderReceiptFromGroup(group, stores, derived.status)}
                      brandName={brandName}
                      onClose={() => setOpenReceiptId(null)}
                    />
                  )}

                  {!derived.isAllCancelled && !derived.isAllDelivered && (
                    <>
                      <RiderMiniMap
                        groupKey={safeGroupKey}
                        orderStatus={derived.status}
                        rider={rider}
                        riderLat={liveRiderLat}
                        riderLng={liveRiderLng}
                        customerLat={group.customerLat}
                        customerLng={group.customerLng}
                        storeMarkers={storeMarkers}
                        quotaExceeded={gmpQuotaExceeded}
                      />
                      {rider ? (
                        <div className="delivery-boy-box">
                          <div>
                            <strong style={{ fontSize: '0.85rem' }}>
                              <i className="fa-solid fa-motorcycle" style={{ color: 'var(--brand-green)' }} />{' '}
                              {rider.name || 'Rider'}
                            </strong>
                            <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
                              {rider.vehicle || 'Bike'}{' '}
                              {riderDist !== null ? `• ~${riderDist.toFixed(1)} km away` : ''}
                            </div>
                          </div>
                          {rider.phone && (
                            <a href={`tel:${rider.phone}`} className="btn btn-outline btn-sm" style={{ color: 'var(--brand-green)' }}>
                              <i className="fa-solid fa-phone" /> Call
                            </a>
                          )}
                        </div>
                      ) : (
                        <div
                          style={{
                            background: '#f0fdf4',
                            border: '1.5px dashed var(--brand-green)',
                            borderRadius: '12px',
                            padding: '0.75rem',
                            margin: '0.65rem 0',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                          }}
                        >
                          <i className="fa-solid fa-satellite-dish fa-spin" style={{ color: 'var(--brand-green)', fontSize: '1.2rem' }} />
                          <div style={{ fontSize: '0.76rem', color: '#166534', fontWeight: 800 }}>
                            Connecting to nearest delivery rider...
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {(derived.status === 'PLACED' || derived.status === 'ACCEPTED') && (
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      style={{
                        color: 'var(--danger)',
                        borderColor: '#fecaca',
                        marginTop: '6px',
                      }}
                      onClick={() => onOpenCancelOrder(safeGroupKey)}
                    >
                      Cancel Order
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      ) : (
        <section className="past-orders-section past-orders-filtered">
          <div className="past-orders-header">
            <h3 className="past-orders-heading">
              {orderFilter === 'DELIVERED' ? 'Delivered Orders' : 'Cancelled Orders'}
            </h3>
          </div>

          {filteredPastOrders.length === 0 ? (
            <div className="orders-empty-card">
              <p className="orders-empty-text">No orders in this section.</p>
            </div>
          ) : (
            <ul className="past-orders-list">
              {filteredPastOrders.map((order) => {
                if (!order) return null;
                const rawItems = Array.isArray(order.items)
                  ? order.items
                  : Object.values(order.items || {});
                const storeName = stores[order.restaurantId]?.name || 'Local Store';
                const normalizedStatus = normalizeOrderStatus(order.status);
                const isDelivered = normalizedStatus === 'DELIVERED';

                return (
                  <li key={order.orderId} className="past-order-item">
                    <div className="past-order-top">
                      <div className="past-order-store">
                        <i className="fa-solid fa-store" />
                        <span>{storeName}</span>
                      </div>
                      <span className={`past-status-badge ${isDelivered ? 'delivered' : 'cancelled'}`}>
                        {normalizedStatus}
                      </span>
                    </div>
                    <div className="past-order-items">
                      {rawItems.map((item) => item ? `${item.name} × ${item.qty}` : '').filter(Boolean).join(', ')}
                    </div>
                    <div className="past-order-meta">
                      <span className="past-order-meta-text">
                        #{order.orderId.slice(-6)} • ₹{Number(order.totalAmount || 0).toFixed(0)}
                      </span>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm past-reorder-btn"
                        onClick={() => onReorderOrder(order)}
                      >
                        <i className="fa-solid fa-rotate-right" /> Reorder
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
};
