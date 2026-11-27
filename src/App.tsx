import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signOut,
  type User,
} from 'firebase/auth';
import { get, onValue, push, ref, runTransaction, set, update } from 'firebase/database';
import { auth, db } from './firebase';
import type {
  AdminSettings,
  CartItem,
  CategoryDef,
  CustomerProfile,
  DeliveryPartner,
  FeedbackItem,
  MenuItem,
  OrderRecord,
  Store,
  TabKey,
  WalletTransaction,
} from './types/bazar';
import {
  DEFAULT_ADMIN_SETTINGS,
  DEFAULT_CATEGORIES,
  DEFAULT_NEARBY_RADIUS_KM,
  calculateOrderCashback,
  darkenHexColor,
  decodeCartFromShareParam,
  deriveGroupOrderStatus,
  doesItemMatchCategory,
  evaluateSpamRisk,
  findNearestAvailableRider,
  generateDeliveryQrToken,
  getProductStockInfo,
  groupCustomerOrders,
  isChutkiPlusActive,
  isValidIndianMobile,
  matchesKeywordSearch,
  mergePastOrderIntoCart,
  mergeSharedCartItems,
  normalizeOrderStatus,
  sanitizeText,
  sortProductsByProximity,
  sortStoresByProximity,
} from './utils/bazarLogic';
import {
  collectKnownUtrs,
  detectSpamContent,
  evaluateActionRateLimit,
  evaluateOrderFraudShield,
  evaluateWalletWithdrawalSafety,
  mapAuthErrorSafe,
  reconcileCartWithCatalog,
  recordRateLimitedAction,
  requiresStrictEmailVerification,
  sanitizeInputBounded,
  sanitizeStoredCartItems,
  stripForbiddenKeysDeep,
  validatePaymentCard,
  validateScreenshotPayload,
  validateUpiUtr,
} from './utils/security';
import {
  buildOrderSnapshotMap,
  detectOrderNotificationEvents,
  detectWalletNotificationEvents,
  type OrderSnapshotState,
} from './utils/notifications';
import { triggerHaptic } from './utils/haptics';
import { usePushNotifications } from './hooks/usePushNotifications';
import {
  checkAccount30DayAutoDeleteStatus,
  prune30DayExpiredOrders,
} from './utils/dataRetention';
import { AuthScreen, EmailVerificationScreen } from './components/AuthScreen';
import { HomeTab } from './components/HomeTab';
import { OrdersTab } from './components/OrdersTab';
import { WalletTab } from './components/WalletTab';
import { ProfileTab } from './components/ProfileTab';
import { ProductDetailModal, StoreMenuModal } from './components/CatalogModals';
import {
  CancelOrderModal,
  CheckoutModal,
  FeedbackModal,
  RefundRequestModal,
  TipRiderModal,
  WalletDepositModal,
  WalletWithdrawModal,
} from './components/CheckoutAndActionModals';
import {
  LivePushBanner,
  NotificationInboxModal,
  OfflineIndicator,
} from './components/PWAControls';

interface ToastItem {
  id: number;
  msg: string;
  type: 'success' | 'danger' | 'info';
}

const CART_STORAGE_KEY = 'gb_ultra_cart';
const USED_UTRS_STORAGE_KEY = 'gb_used_utrs';
const TIMELINE_TS_STORAGE_KEY = 'gb_order_timeline_ts_v1';

function loadSavedTimelineTimestamps(): Record<string, Record<string, number>> {
  try {
    const raw = localStorage.getItem(TIMELINE_TS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, Record<string, number>>;
  } catch {
    return {};
  }
}

function loadSavedCart(): CartItem[] {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { items?: unknown };
    return sanitizeStoredCartItems(parsed.items);
  } catch {
    return [];
  }
}

function loadSavedUsedUtrs(): string[] {
  try {
    const raw = localStorage.getItem(USED_UTRS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => String(v || '').trim())
      .filter((v) => /^\d{12}$/.test(v))
      .slice(-50);
  } catch {
    return [];
  }
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authVerifyTick, setAuthVerifyTick] = useState(0);
  const [isCheckingVerification, setIsCheckingVerification] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [verifyResendCooldownSec, setVerifyResendCooldownSec] = useState(0);
  const [verifyStatusMsg, setVerifyStatusMsg] = useState('');
  const [verifyStatusErr, setVerifyStatusErr] = useState('');

  const activeUserSnapshot = useMemo(() => {
    void authVerifyTick;
    if (!currentUser) return null;
    if (auth.currentUser && auth.currentUser.uid === currentUser.uid) {
      return auth.currentUser;
    }
    return currentUser;
  }, [authVerifyTick, currentUser]);

  const activeUid = currentUser?.uid || null;
  const isLoggedIn = Boolean(currentUser);
  const needsEmailVerification = requiresStrictEmailVerification({
    user: activeUserSnapshot,
  });

  // Core Firebase states
  const [customerProfile, setCustomerProfile] = useState<CustomerProfile | null>(null);
  const [stores, setStores] = useState<Record<string, Store>>({});
  const [allMenus, setAllMenus] = useState<
    Record<string, Record<string, Omit<MenuItem, 'itemId' | 'storeId'>>>
  >({});
  const [deliveryPartners, setDeliveryPartners] = useState<
    Record<string, DeliveryPartner>
  >({});
  const [cachedOrders, setCachedOrders] = useState<
    Record<string, Omit<OrderRecord, 'orderId'>>
  >({});
  const [walletTransactions, setWalletTransactions] = useState<
    Record<string, WalletTransaction>
  >({});
  const [myFeedbacks, setMyFeedbacks] = useState<Record<string, FeedbackItem>>({});
  const [settings, setSettings] = useState<AdminSettings>(DEFAULT_ADMIN_SETTINGS);

  // Navigation & filter states
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    if (typeof window === 'undefined') return 'home';
    const urlTab = new URLSearchParams(window.location.search).get('tab');
    if (urlTab === 'orders' || urlTab === 'wallet' || urlTab === 'profile') {
      return urlTab;
    }
    return 'home';
  });
  const [currentCategoryFilter, setCurrentCategoryFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [isVoiceListening, setIsVoiceListening] = useState(false);

  // Cart & modals
  const [cartItems, setCartItems] = useState<CartItem[]>(loadSavedCart);
  const [localUsedUtrs, setLocalUsedUtrs] = useState<string[]>(loadSavedUsedUtrs);
  const [menuStoreId, setMenuStoreId] = useState<string | null>(null);
  const [detailItemRef, setDetailItemRef] = useState<{
    storeId: string;
    itemId: string;
  } | null>(null);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [isDepositOpen, setIsDepositOpen] = useState(false);
  const [isWithdrawOpen, setIsWithdrawOpen] = useState(false);
  const [tipRiderGroupKey, setTipRiderGroupKey] = useState<string | null>(null);
  const [refundOrderTarget, setRefundOrderTarget] = useState<OrderRecord | null>(null);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [cancelGroupKey, setCancelGroupKey] = useState<string | null>(null);
  const [isInboxOpen, setIsInboxOpen] = useState(false);

  // GPS & Async states
  const [detectedLat, setDetectedLat] = useState<number | null>(null);
  const [detectedLng, setDetectedLng] = useState<number | null>(null);
  const [detectedLocationLink, setDetectedLocationLink] = useState('');
  const [isFetchingCheckoutGps, setIsFetchingCheckoutGps] = useState(false);
  const [isDetectingProfileGps, setIsDetectingProfileGps] = useState(false);
  const [isDetectingHomeGps, setIsDetectingHomeGps] = useState(false);
  const [isLiveGpsTracking, setIsLiveGpsTracking] = useState(false);
  const [isPlacingOrder, setIsPlacingOrder] = useState(false);
  const [isActivatingPlus, setIsActivatingPlus] = useState(false);
  const [isSubmittingAction, setIsSubmittingAction] = useState(false);

  // Toasts & Maps Quota Guard
  const [gmpQuotaExceeded, setGmpQuotaExceeded] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastCounter = useRef(0);
  const lastBackPressRef = useRef(0);
  const lastWithdrawAtRef = useRef(0);
  const actionRateHistoryRef = useRef<Record<string, number[]>>({});
  const pendingSharedCartTokenRef = useRef<string | null>(
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('cart')
      : null
  );
  const cartItemsRef = useRef<CartItem[]>(cartItems);
  cartItemsRef.current = cartItems;

  useEffect(() => {
    const onQuotaExceeded = () => setGmpQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuotaExceeded);
    return () => {
      window.removeEventListener('gmp-quota-exceeded', onQuotaExceeded);
    };
  }, []);

  const showToast = useCallback(
    (msg: string, type: 'success' | 'danger' | 'info' = 'success') => {
      const id = ++toastCounter.current;
      setToasts((prev) => [...prev.filter((t) => t.msg !== msg), { id, msg, type }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3500);
    },
    []
  );

  const switchNav = useCallback(
    (tabName: TabKey, pushHistory = true, withHaptic = false) => {
      if (withHaptic && activeTab !== tabName) {
        triggerHaptic('tap');
      }
      setActiveTab((prev) => {
        if (prev === tabName) return prev;
        if (pushHistory) {
          window.history.pushState({ screen: tabName }, '');
        }
        return tabName;
      });
    },
    [activeTab]
  );

  // Push Notifications hook
  const {
    permission: pushPermission,
    notifications,
    unreadCount,
    activeBanner,
    promptDismissed,
    enablePushNotifications,
    sendTestPush,
    pushNotification,
    markNotificationRead,
    markAllRead,
    clearInbox,
    dismissBanner,
    dismissPrompt,
  } = usePushNotifications(activeUid, (tab) => switchNav(tab));

  // Persist cart
  useEffect(() => {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify({ items: cartItems }));
    } catch {
      // Ignore quota errors
    }
  }, [cartItems]);

  const recordUsedUtr = useCallback((utr: string) => {
    const clean = String(utr || '').trim();
    if (!/^\d{12}$/.test(clean)) return;
    setLocalUsedUtrs((prev) => {
      if (prev.includes(clean)) return prev;
      const next = [...prev, clean].slice(-50);
      try {
        localStorage.setItem(USED_UTRS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  // Reconcile client cart against authoritative catalog
  useEffect(() => {
    if (
      cartItemsRef.current.length === 0 ||
      Object.keys(stores).length === 0 ||
      Object.keys(allMenus).length === 0
    ) {
      return;
    }
    const { safeCart, tamperedCount, removedCount } = reconcileCartWithCatalog(
      cartItemsRef.current,
      stores,
      allMenus
    );
    if (tamperedCount > 0 || removedCount > 0) {
      setCartItems(safeCart);
      showToast('🛡️ Cart prices synced to live verified store catalog.', 'info');
    }
  }, [allMenus, showToast, stores]);

  // Derived CMS configuration
  const adminUpiId = settings.upiId || 'gossaigaonbazar@apl';
  const appBrandName = settings.appBrandName || 'Chutki';
  const baseDeliveryCharge =
    settings.deliveryCharge !== undefined ? Number(settings.deliveryCharge) : 25;
  const freeDeliveryMinOrder =
    settings.freeDeliveryAbove !== undefined
      ? Number(settings.freeDeliveryAbove)
      : 299;
  const handlingFee =
    settings.handlingFee !== undefined ? Number(settings.handlingFee) : 0;
  const allowChutkiPlus = settings.allowChutkiPlus !== false;
  const plusPlanPrice =
    settings.plusPlanPrice !== undefined ? Number(settings.plusPlanPrice) : 99;
  const plusValidityDays =
    settings.plusValidityDays !== undefined
      ? Math.max(1, Number(settings.plusValidityDays))
      : 30;
  const allowCashback = settings.allowCashback !== false;
  const cashbackPercent =
    settings.cashbackPercent !== undefined ? Number(settings.cashbackPercent) : 5;
  const allowRiderTip = settings.allowRiderTip !== false;
  const riderTipOptions = useMemo(
    () =>
      Array.isArray(settings.riderTipOptions) && settings.riderTipOptions.length > 0
        ? settings.riderTipOptions
        : [10, 20, 30, 50],
    [settings.riderTipOptions]
  );
  const allowScheduledDelivery = settings.allowScheduledDelivery !== false;
  const customDeliverySlots = settings.customDeliverySlots;
  const showStockBadges = settings.showStockBadges !== false;
  const enforceStockLimits = settings.enforceStockLimits !== false;
  const allowFavoriteStores = settings.allowFavoriteStores !== false;
  const allowStoreQuickAdd = settings.allowStoreQuickAdd !== false;
  const allowRefundRequests = settings.allowRefundRequests !== false;
  const allowDeliveryQr = settings.allowDeliveryQr !== false;
  const nearbyRadiusKm =
    settings.nearbyRadiusKm !== undefined && Number(settings.nearbyRadiusKm) > 0
      ? Number(settings.nearbyRadiusKm)
      : DEFAULT_NEARBY_RADIUS_KM;
  const prioritizeNearbyStores = settings.prioritizeNearbyStores !== false;
  const activeCustomerLat =
    detectedLat !== null && Number.isFinite(detectedLat)
      ? detectedLat
      : typeof customerProfile?.lat === 'number' && Number.isFinite(customerProfile.lat)
        ? customerProfile.lat
        : null;
  const activeCustomerLng =
    detectedLng !== null && Number.isFinite(detectedLng)
      ? detectedLng
      : typeof customerProfile?.lng === 'number' && Number.isFinite(customerProfile.lng)
        ? customerProfile.lng
        : null;
  const isPlusActive = isChutkiPlusActive(customerProfile);
  const minOrderAmount =
    settings.minOrderAmount !== undefined ? Number(settings.minOrderAmount) : 0;

  const minCustomerDeposit =
    settings.minCustomerDeposit !== undefined
      ? Number(settings.minCustomerDeposit)
      : 50;
  const maxCustomerDeposit =
    settings.maxCustomerDeposit !== undefined
      ? Number(settings.maxCustomerDeposit)
      : 5000;
  const minCustomerWithdraw =
    settings.minCustomerWithdraw !== undefined
      ? Number(settings.minCustomerWithdraw)
      : 50;
  const maxCustomerWithdraw =
    settings.maxCustomerWithdraw !== undefined
      ? Number(settings.maxCustomerWithdraw)
      : 5000;

  const allowReferrals = settings.allowReferrals !== false;
  const referrerBonus =
    settings.referrerBonus !== undefined ? Number(settings.referrerBonus) : 25;
  const refereeBonus =
    settings.refereeBonus !== undefined ? Number(settings.refereeBonus) : 25;

  const cmsCouponCode = settings.activeCouponCode
    ? settings.activeCouponCode.toUpperCase()
    : 'GOSSAIGAON20';
  const cmsCouponDiscount = Number(settings.activeCouponDiscount || 20);
  const cmsCouponMinOrder = Number(
    settings.couponMinOrder !== undefined ? settings.couponMinOrder : 100
  );

  const allowCod = settings.allowCod !== false;
  const allowUpi = settings.allowUpi !== false;
  const allowCardPayment = settings.allowCardPayment !== false;
  const allowWalletPayment = settings.allowWalletPayment !== false;
  const allowCoupons = settings.allowCoupons !== false;
  const allowVoiceSearch = settings.allowVoiceSearch !== false;
  const strictAntiScamShield = settings.strictAntiScamShield !== false;
  const codMaxOrderAmount =
    settings.codMaxOrderAmount !== undefined && Number(settings.codMaxOrderAmount) > 0
      ? Number(settings.codMaxOrderAmount)
      : 3000;
  const maxActiveOrdersPerUser =
    settings.maxActiveOrdersPerUser !== undefined && Number(settings.maxActiveOrdersPerUser) > 0
      ? Number(settings.maxActiveOrdersPerUser)
      : 5;
  const blockCodForFlaggedUsers = settings.blockCodForFlaggedUsers !== false;
  const spamAutoBlockThreshold =
    settings.spamAutoBlockThreshold !== undefined && Number(settings.spamAutoBlockThreshold) > 0
      ? Number(settings.spamAutoBlockThreshold)
      : 3;
  const actionCooldownMs =
    settings.actionCooldownMs !== undefined && Number(settings.actionCooldownMs) >= 0
      ? Number(settings.actionCooldownMs)
      : 15000;
  const maintenanceMode = settings.maintenanceMode === true;
  const maintenanceMessage =
    settings.maintenanceMessage ||
    'Chutki is currently closed for maintenance. Opening soon!';

  const categories = useMemo<CategoryDef[]>(() => {
    if (Array.isArray(settings.customCategories) && settings.customCategories.length > 0) {
      const list = settings.customCategories.filter((c) => c && c.active !== false);
      if (!list.some((c) => c.id === 'ALL_STORES')) {
        list.splice(1, 0, {
          id: 'ALL_STORES',
          name: 'All Store',
          icon: '🏪',
          keywords: [],
          active: true,
        });
      }
      if (!list.some((c) => c.id === 'FAVORITES')) {
        list.splice(2, 0, {
          id: 'FAVORITES',
          name: 'Favorites',
          icon: '❤️',
          keywords: [],
          active: true,
        });
      }
      return list;
    }
    return DEFAULT_CATEGORIES;
  }, [settings.customCategories]);

  useEffect(() => {
    if (!categories.some((c) => c.id === currentCategoryFilter)) {
      setCurrentCategoryFilter('ALL');
    }
  }, [categories, currentCategoryFilter]);

  // Apply CMS Theme CSS variables
  useEffect(() => {
    const root = document.documentElement;
    if (settings.themePrimaryColor) {
      root.style.setProperty('--brand-green', settings.themePrimaryColor);
      root.style.setProperty('--primary', settings.themePrimaryColor);
      root.style.setProperty('--success', settings.themePrimaryColor);
      root.style.setProperty(
        '--brand-green-dark',
        darkenHexColor(settings.themePrimaryColor)
      );
    } else {
      root.style.setProperty('--brand-green', '#0c831f');
      root.style.setProperty('--primary', '#0c831f');
      root.style.setProperty('--success', '#0c831f');
      root.style.setProperty('--brand-green-dark', '#075e14');
    }
    if (settings.themeAccentColor) {
      root.style.setProperty('--brand-yellow', settings.themeAccentColor);
    } else {
      root.style.setProperty('--brand-yellow', '#f8cb46');
    }
    if (settings.themeBgColor) {
      root.style.setProperty('--bg', settings.themeBgColor);
    } else {
      root.style.setProperty('--bg', '#f4f6fb');
    }
    if (settings.appBrandName) {
      document.title = `${settings.appBrandName} - Express Delivery`;
    } else {
      document.title = 'Chutki - 15-Minute Grocery Delivery';
    }
  }, [settings]);

  // Auth listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setVerifyStatusMsg('');
      setVerifyStatusErr('');
      setVerifyResendCooldownSec(0);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (verifyResendCooldownSec <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setVerifyResendCooldownSec((sec) => Math.max(0, sec - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [verifyResendCooldownSec]);

  // Real-time RTDB listeners
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    unsubs.push(
      onValue(ref(db, 'admin/settings'), (snap) => {
        const s = snap.val() as AdminSettings | null;
        if (s && Object.keys(s).length > 0) {
          setSettings((prev) => ({ ...DEFAULT_ADMIN_SETTINGS, ...prev, ...s }));
        }
      })
    );

    unsubs.push(
      onValue(ref(db, 'restaurants'), (snap) => {
        const val = snap.val() as Record<string, Store> | null;
        if (val && Object.keys(val).length > 0) {
          setStores(val);
        }
      })
    );

    unsubs.push(
      onValue(ref(db, 'menus'), (snap) => {
        const val = snap.val() as Record<
          string,
          Record<string, Omit<MenuItem, 'itemId' | 'storeId'>>
        > | null;
        if (val && Object.keys(val).length > 0) {
          setAllMenus(val);
        }
      })
    );

    unsubs.push(
      onValue(ref(db, 'deliveryPartners'), (snap) => {
        const val = snap.val() as Record<string, DeliveryPartner> | null;
        if (val && Object.keys(val).length > 0) {
          setDeliveryPartners(val);
        }
      })
    );

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, []);

  // Customer-specific real-time listeners
  useEffect(() => {
    if (!currentUser || needsEmailVerification) return;
    const uid = currentUser.uid;
    const unsubs: Array<() => void> = [];

    unsubs.push(
      onValue(ref(db, `customers/${uid}`), (snap) => {
        const data = (snap.val() || {}) as CustomerProfile;
        if (!data.referralCode) {
          const code = 'GB' + uid.slice(0, 6).toUpperCase();
          void set(ref(db, `customers/${uid}/referralCode`), code);
          data.referralCode = code;
        }
        setCustomerProfile(data);
        if (data.lat && data.lng) {
          setDetectedLat(data.lat);
          setDetectedLng(data.lng);
          setDetectedLocationLink(data.locationLink || '');
        }
      })
    );

    unsubs.push(
      onValue(ref(db, `walletTransactions/${uid}`), (snap) => {
        const txMap = (snap.val() || {}) as Record<string, WalletTransaction>;
        setWalletTransactions(txMap);
      })
    );

    unsubs.push(
      onValue(ref(db, 'feedbacks'), (snap) => {
        const allFb = (snap.val() || {}) as Record<string, FeedbackItem>;
        const mine: Record<string, FeedbackItem> = {};
        Object.entries(allFb).forEach(([id, f]) => {
          if (f.uid === uid) mine[id] = f;
        });
        setMyFeedbacks(mine);
      })
    );

    unsubs.push(
      onValue(ref(db, 'orders'), (snap) => {
        const allOrd = (snap.val() || {}) as Record<
          string,
          Omit<OrderRecord, 'orderId'>
        >;
        const mine: Record<string, Omit<OrderRecord, 'orderId'>> = {};
        Object.entries(allOrd).forEach(([id, o]) => {
          if (o.customerUid === uid) mine[id] = o;
        });
        const { retainedOrders } = prune30DayExpiredOrders(mine);
        setCachedOrders(retainedOrders);
      })
    );

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [currentUser, needsEmailVerification]);

  // Native Android Geolocation Helper (Prompts system dialog on phone)
  const getCoordinatesSafe = async (): Promise<{ lat: number; lng: number }> => {
    const isNative =
      typeof (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor !== 'undefined' &&
      Boolean((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());

    if (isNative) {
      try {
        const { Geolocation } = await import('@capacitor/geolocation');
        const perm = await Geolocation.requestPermissions();
        if (perm.location !== 'granted') {
          throw new Error('Location permission denied. Phone Settings > Apps > Chutki me jakar Location allow karein.');
        }
        const pos = await Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 15000,
        });
        return {
          lat: Number(pos.coords.latitude.toFixed(6)),
          lng: Number(pos.coords.longitude.toFixed(6)),
        };
      } catch (err: unknown) {
        const msg = String(err instanceof Error ? err.message : err || '');
        if (msg.includes('denied')) {
          throw new Error('Location permission denied. Phone Settings > Apps > Chutki me jakar Location allow karein.');
        }
        throw err;
      }
    }

    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('GPS unavailable on this device.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: Number(pos.coords.latitude.toFixed(6)),
            lng: Number(pos.coords.longitude.toFixed(6)),
          }),
        (err) => reject(new Error(err.message)),
        { enableHighAccuracy: true, timeout: 15000 }
      );
    });
  };

  const handleCheckoutGps = async () => {
    setIsFetchingCheckoutGps(true);
    try {
      const { lat, lng } = await getCoordinatesSafe();
      const link = `https://www.google.com/maps?q=${lat},${lng}`;
      setDetectedLat(lat);
      setDetectedLng(lng);
      setDetectedLocationLink(link);
      try {
        const resp = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1`
        );
        const data = (await resp.json()) as {
          address?: {
            house_number?: string;
            road?: string;
            suburb?: string;
            village?: string;
            town?: string;
            city?: string;
          };
        };
        if (data?.address) {
          const addr = data.address;
          const area = addr.village || addr.town || addr.city || 'Gossaigaon';
          const built =
            [addr.house_number, addr.road || addr.suburb, area]
              .filter(Boolean)
              .join(', ') || 'Gossaigaon';
          setCustomerProfile((prev) => ({
            ...(prev || {}),
            lat,
            lng,
            locationLink: link,
            address: built,
          }));
        } else {
          setCustomerProfile((prev) => ({ ...(prev || {}), lat, lng, locationLink: link }));
        }
      } catch {
        setCustomerProfile((prev) => ({ ...(prev || {}), lat, lng, locationLink: link }));
      }
      showToast('📍 Doorstep GPS Fixed!', 'success');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'GPS Error', 'danger');
    } finally {
      setIsFetchingCheckoutGps(false);
    }
  };

  const handleProfileGps = async () => {
    setIsDetectingProfileGps(true);
    try {
      const { lat, lng } = await getCoordinatesSafe();
      const link = `https://www.google.com/maps?q=${lat},${lng}`;
      setDetectedLat(lat);
      setDetectedLng(lng);
      setDetectedLocationLink(link);
      let newAddress = customerProfile?.address || 'Gossaigaon';
      try {
        const resp = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1`
        );
        const data = (await resp.json()) as {
          address?: {
            road?: string;
            town?: string;
            city?: string;
            village?: string;
          };
        };
        if (data?.address) {
          const town =
            data.address.town ||
            data.address.city ||
            data.address.village ||
            'Gossaigaon';
          newAddress = `${data.address.road ? data.address.road + ', ' : ''}${town}`;
        }
        setCustomerProfile((prev) => ({
          ...(prev || {}),
          lat,
          lng,
          locationLink: link,
          address: newAddress,
        }));
        if (currentUser) {
          await update(ref(db, `customers/${currentUser.uid}`), {
            lat,
            lng,
            locationLink: link,
            address: newAddress,
            updatedAt: Date.now(),
          });
        }
        showToast('📍 Exact Profile GPS Saved!', 'success');
      } catch {
        setCustomerProfile((prev) => ({
          ...(prev || {}),
          lat,
          lng,
          locationLink: link,
          address: newAddress,
        }));
        showToast('📍 GPS Coordinates Pinned!', 'success');
      }
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'GPS Error', 'danger');
    } finally {
      setIsDetectingProfileGps(false);
    }
  };

  const handleHomeGpsDetect = async () => {
    setIsDetectingHomeGps(true);
    try {
      const { lat, lng } = await getCoordinatesSafe();
      applyRealtimeGpsCoords(lat, lng);
      setIsLiveGpsTracking(true);
      triggerHaptic('success');
      showToast(
        `📍 Live GPS updated — stores within ${nearbyRadiusKm} km sorted first!`,
        'success'
      );
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'GPS Error', 'danger');
    } finally {
      setIsDetectingHomeGps(false);
    }
  };

  const applyRealtimeGpsCoords = useCallback(
    (rawLat: number, rawLng: number) => {
      if (!Number.isFinite(rawLat) || !Number.isFinite(rawLng)) return;
      const lat = Number(rawLat.toFixed(6));
      const lng = Number(rawLng.toFixed(6));
      const link = `https://www.google.com/maps?q=${lat},${lng}`;
      setDetectedLat((prev) =>
        prev !== null && Math.abs(prev - lat) < 0.00025 ? prev : lat
      );
      setDetectedLng((prev) =>
        prev !== null && Math.abs(prev - lng) < 0.00025 ? prev : lng
      );
      setDetectedLocationLink(link);
    },
    []
  );

  // Voice Search (Native Microphone in APK + Web fallback)
  const startVoiceSearch = async () => {
    const isNative =
      typeof (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor !== 'undefined' &&
      Boolean((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());

    if (isNative) {
      try {
        const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
        const hasPerm = await SpeechRecognition.hasPermission();
        if (!hasPerm.permission) {
          await SpeechRecognition.requestPermission();
        }
        setIsVoiceListening(true);
        const result = await SpeechRecognition.start({
          language: 'hi-IN',
          maxResults: 2,
          prompt: 'Boliye kya chahiye...',
          partialResults: false,
          popup: true,
        });
        setIsVoiceListening(false);
        if (result.matches && result.matches.length > 0) {
          setSearchQuery(result.matches[0]);
          triggerHaptic('success');
        }
      } catch {
        setIsVoiceListening(false);
        const input = document.getElementById('store-search-input');
        input?.focus();
        showToast('Keyboard ke mic icon par tap karke bolein', 'info');
      }
      return;
    }

    const win = window as unknown as {
      SpeechRecognition?: new () => any;
      webkitSpeechRecognition?: new () => any;
    };
    const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SR) {
      const input = document.getElementById('store-search-input');
      input?.focus();
      showToast('Keyboard ke mic icon par tap karke bolein', 'info');
      return;
    }
    const rec = new SR();
    rec.lang = 'en-IN';
    setIsVoiceListening(true);
    rec.onresult = (ev: any) => {
      setSearchQuery(sanitizeText(ev.results[0][0].transcript));
      setIsVoiceListening(false);
    };
    rec.onerror = () => setIsVoiceListening(false);
    rec.onend = () => setIsVoiceListening(false);
    rec.start();
  };

  // Cart actions
  const getItemQuantityInCart = useCallback(
    (itemId: string, storeId: string) => {
      const found = cartItems.find(
        (i) =>
          String(i.itemId) === String(itemId) &&
          (!storeId || String(i.storeId) === String(storeId))
      );
      return found ? found.qty : 0;
    },
    [cartItems]
  );

  const updateCartQtySafe = useCallback(
    (
      itemId: string,
      storeId: string,
      change: number,
      e?: React.MouseEvent
    ): boolean => {
      if (e) e.stopPropagation();
      const storeData = stores[storeId];
      if (
        change > 0 &&
        (!storeData ||
          storeData.approved !== true ||
          storeData.suspended === true ||
          storeData.isOpen === false)
      ) {
        triggerHaptic('error');
        showToast(
          '🔴 Yeh store abhi offline/closed hai. Order nahi le raha!',
          'danger'
        );
        return false;
      }
      const itemData = allMenus[storeId]?.[itemId];
      if (
        change > 0 &&
        (!itemData || itemData.available === false || itemData.adminApproved !== true)
      ) {
        triggerHaptic('error');
        showToast('Yeh product abhi sale ke liye available nahi hai.', 'danger');
        return false;
      }

      if (change > 0) {
        const stockInfo = getProductStockInfo(itemData);
        if (enforceStockLimits && stockInfo.isOutOfStock) {
          triggerHaptic('error');
          showToast(`⚠️ "${itemData?.name || 'Product'}" abhi Out of Stock hai!`, 'danger');
          return false;
        }
        triggerHaptic('cartAdd');
      } else if (change < 0) {
        triggerHaptic('cartRemove');
      }

      setCartItems((prev) => {
        const next = [...prev];
        const idx = next.findIndex(
          (i) =>
            String(i.itemId) === String(itemId) &&
            String(i.storeId) === String(storeId)
        );
        if (idx > -1) {
          const updatedQty = next[idx].qty + change;
          if (updatedQty <= 0) next.splice(idx, 1);
          else next[idx] = { ...next[idx], qty: updatedQty };
        } else if (change > 0 && itemData) {
          next.push({
            itemId: String(itemId),
            name: itemData.name || 'Grocery Item',
            price: Number(itemData.price || 0),
            qty: 1,
            imageUrl: itemData.imageUrl || '',
            storeId: String(storeId || ''),
            storeName: storeData?.name || 'Grocery Store',
          });
        }
        return next;
      });
      return true;
    },
    [allMenus, enforceStockLimits, showToast, stores]
  );

  const toggleFavoriteItem = useCallback(
    (storeId: string, itemId: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation();
      if (!activeUid) return;
      const key = `${storeId}___${itemId}`;
      const currentlyFav = Boolean(customerProfile?.favorites?.[key]);
      triggerHaptic(currentlyFav ? 'tap' : 'favorite');

      void set(
        ref(db, `customers/${activeUid}/favorites/${key}`),
        currentlyFav ? null : true
      ).then(() => {
        showToast(
          currentlyFav ? 'Removed from Favorites' : '❤️ Added to Favorites!',
          'info'
        );
      });
    },
    [activeUid, customerProfile?.favorites, showToast]
  );

  const toggleFavoriteStore = useCallback(
    (storeId: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation();
      if (!activeUid || !storeId) return;
      const currentlyFav = Boolean(customerProfile?.favoriteStores?.[storeId]);
      const storeName = stores[storeId]?.name || 'Store';
      triggerHaptic(currentlyFav ? 'tap' : 'favorite');

      void set(
        ref(db, `customers/${activeUid}/favoriteStores/${storeId}`),
        currentlyFav ? null : true
      ).then(() => {
        showToast(
          currentlyFav
            ? `Removed ${storeName} from Saved Stores`
            : `❤️ ${storeName} saved to Favourite Stores!`,
          'info'
        );
      });
    },
    [activeUid, customerProfile?.favoriteStores, showToast, stores]
  );

  const handleActivateChutkiPlus = useCallback(async () => {
    if (!activeUid || isActivatingPlus) return;
    const curBal = Number(customerProfile?.walletBalance || 0);
    if (curBal < plusPlanPrice) {
      triggerHaptic('error');
      showToast(
        `Add ₹${Math.ceil(plusPlanPrice - curBal)} more to Wallet to activate Chutki Plus (₹${plusPlanPrice})!`,
        'danger'
      );
      switchNav('wallet');
      setIsDepositOpen(true);
      return;
    }

    setIsActivatingPlus(true);
    try {
      const activeUntil = Date.now() + plusValidityDays * 24 * 60 * 60 * 1000;
      const txResult = await runTransaction(
        ref(db, `customers/${activeUid}/walletBalance`),
        (bal) => {
          const cur = Number(bal || 0);
          if (cur < plusPlanPrice) return;
          return Number((cur - plusPlanPrice).toFixed(2));
        }
      );
      if (!txResult.committed) {
        showToast('Insufficient Wallet balance for Chutki Plus!', 'danger');
        return;
      }
      await update(ref(db, `customers/${activeUid}`), {
        plusActiveUntil: activeUntil,
        updatedAt: Date.now(),
      });
      await push(ref(db, `walletTransactions/${activeUid}`), {
        type: 'DEBIT',
        amount: plusPlanPrice,
        note: `👑 Chutki Plus ${plusValidityDays}-Day Free Delivery Pass`,
        createdAt: Date.now(),
      });
      triggerHaptic('success');
      showToast(
        `👑 Chutki Plus Activated for ${plusValidityDays} days! Enjoy FREE delivery.`,
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Could not activate Chutki Plus.',
        'danger'
      );
    } finally {
      setIsActivatingPlus(false);
    }
  }, [
    activeUid,
    customerProfile?.walletBalance,
    isActivatingPlus,
    plusPlanPrice,
    plusValidityDays,
    showToast,
    switchNav,
  ]);

  const handleSaveProfile = (nameRaw: string, phoneRaw: string, addressRaw: string) => {
    const name = sanitizeInputBounded(nameRaw, 80);
    const phone = phoneRaw.replace(/\D/g, '').slice(0, 10);
    const address = sanitizeInputBounded(addressRaw, 220);
    if (name.length < 2) return showToast('Enter your full name!', 'danger');
    if (!isValidIndianMobile(phone)) return showToast('Enter valid 10-digit mobile number!', 'danger');
    if (address.length < 5) return showToast('Enter complete delivery address!', 'danger');

    const updates: Partial<CustomerProfile> = { name, phone, address, updatedAt: Date.now() };
    if (detectedLat && detectedLng) {
      updates.lat = detectedLat;
      updates.lng = detectedLng;
      updates.locationLink = detectedLocationLink;
    }

    if (currentUser) {
      void update(ref(db, `customers/${currentUser.uid}`), updates)
        .then(() => showToast('Profile saved!', 'success'))
        .catch(() => showToast('Could not save profile.', 'danger'));
    }
  };

  const handlePlaceOrder = async (payload: {
    address: string;
    phone: string;
    paymentMode: 'COD' | 'UPI' | 'CARD' | 'WALLET';
    utr: string;
    screenshotData: string;
    appliedDiscount: number;
    appliedCouponCode: string;
    riderTip: number;
    deliverySlot: string;
    cardHolderName?: string;
    cardNumber?: string;
    cardExpiry?: string;
    cardCvv?: string;
  }) => {
    if (isPlacingOrder || !activeUid) return;
    if (maintenanceMode) return showToast(`🚧 ${maintenanceMessage}`, 'danger');
    if (cartItems.length === 0) return showToast('Cart is empty!', 'danger');

    const { safeCart: verifiedCartItems } = reconcileCartWithCatalog(cartItems, stores, allMenus);
    const address = sanitizeInputBounded(payload.address, 220);
    const phone = payload.phone.replace(/\D/g, '').slice(0, 10);
    const utr = payload.utr.replace(/\D/g, '').slice(0, 12);

    if (address.length < 6) return showToast('Poora delivery address enter karein!', 'danger');
    if (!isValidIndianMobile(phone)) return showToast('Valid 10-digit mobile number enter karein!', 'danger');

    // Group items by store
    const storeBatches: Record<string, { storeName: string; items: CartItem[]; subtotal: number }> = {};
    let totalItemsSubtotal = 0;
    verifiedCartItems.forEach((item) => {
      const sId = item.storeId || 'general';
      if (!storeBatches[sId]) {
        storeBatches[sId] = { storeName: item.storeName || 'Store', items: [], subtotal: 0 };
      }
      storeBatches[sId].items.push(item);
      storeBatches[sId].subtotal += item.price * item.qty;
      totalItemsSubtotal += item.price * item.qty;
    });

    const isFreeDelivery = (allowChutkiPlus && isPlusActive) || totalItemsSubtotal >= freeDeliveryMinOrder;
    const delCharge = isFreeDelivery ? 0 : baseDeliveryCharge;
    const cleanTip = allowRiderTip ? Math.max(0, Math.min(500, Math.round(Number(payload.riderTip || 0)))) : 0;
    const netPayableTotal = Math.max(1, totalItemsSubtotal + delCharge + handlingFee + cleanTip - payload.appliedDiscount);

    if (payload.paymentMode === 'WALLET') {
      const curBal = Number(customerProfile?.walletBalance || 0);
      if (curBal < netPayableTotal) return showToast(`Insufficient Wallet balance!`, 'danger');
    }

    setIsPlacingOrder(true);
    try {
      const deliveryOtp = Math.floor(1000 + Math.random() * 9000).toString();
      const deliveryQrToken = generateDeliveryQrToken();
      const batchGroupId = 'COMBO_' + Date.now();
      const accurateLocationLink = detectedLat && detectedLng ? `https://www.google.com/maps?q=${detectedLat},${detectedLng}` : '';

      if (payload.paymentMode === 'WALLET') {
        await runTransaction(ref(db, `customers/${activeUid}/walletBalance`), (bal) => {
          const cur = Number(bal || 0);
          if (cur < netPayableTotal) return;
          return Number((cur - netPayableTotal).toFixed(2));
        });
        await push(ref(db, `walletTransactions/${activeUid}`), {
          type: 'DEBIT',
          amount: Number(netPayableTotal.toFixed(2)),
          note: 'Paid for grocery order',
          createdAt: Date.now(),
        });
      }

      const orderPromises: Array<PromiseLike<unknown>> = [];
      let isFirstStore = true;

      Object.entries(storeBatches).forEach(([sId, batch]) => {
        const currentStore = stores[sId] || {};
        const assignedRiderUid = findNearestAvailableRider(deliveryPartners, currentStore.lat, currentStore.lng);
        const assignedRiderObj = assignedRiderUid ? deliveryPartners[assignedRiderUid] : null;
        const isFirst = isFirstStore;
        const batchDeliveryCharge = isFreeDelivery ? 0 : isFirst ? baseDeliveryCharge : 0;
        const batchTotal = Math.max(1, batch.subtotal + batchDeliveryCharge + (isFirst ? cleanTip : 0));
        isFirstStore = false;

        const orderData = {
          batchGroupId,
          customerUid: activeUid,
          restaurantId: sId,
          deliveryUid: assignedRiderUid || null,
          riderLat: assignedRiderObj?.lat || null,
          riderLng: assignedRiderObj?.lng || null,
          assignedAt: assignedRiderUid ? Date.now() : null,
          items: batch.items,
          subtotalAmount: Number(batch.subtotal.toFixed(2)),
          deliveryCharge: Number(batchDeliveryCharge.toFixed(2)),
          handlingFee: Number((isFirst ? handlingFee : 0).toFixed(2)),
          riderTip: isFirst ? cleanTip : 0,
          totalAmount: Number(batchTotal.toFixed(2)),
          address,
          phone,
          customerLat: detectedLat || null,
          customerLng: detectedLng || null,
          locationLink: accurateLocationLink,
          deliveryOtp,
          deliveryQrToken,
          status: 'PLACED',
          paymentMode: payload.paymentMode,
          paymentStatus: payload.paymentMode === 'COD' ? 'COD' : 'VERIFIED',
          transactionId: payload.paymentMode === 'UPI' ? utr : '',
          placedAt: Date.now(),
          statusTimestamps: { PLACED: Date.now() },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        orderPromises.push(push(ref(db, 'orders'), stripForbiddenKeysDeep(orderData)));
      });

      await Promise.all(orderPromises);
      setCartItems([]);
      setIsCheckoutOpen(false);
      switchNav('orders');
      triggerHaptic('success');
      showToast(`🎉 Order Placed! PIN: ${deliveryOtp}`, 'success');
    } catch (err) {
      showToast('Error: ' + (err instanceof Error ? err.message : 'Order failed'), 'danger');
    } finally {
      setIsPlacingOrder(false);
    }
  };

  const handleWalletDepositSubmit = async (amt: number, utrRaw: string, screenshotData: string) => {
    if (isSubmittingAction || !activeUid) return;
    const cleanUtr = utrRaw.replace(/\D/g, '').slice(0, 12);
    setIsSubmittingAction(true);
    try {
      await push(ref(db, 'walletRequests'), {
        type: 'DEPOSIT',
        customerUid: activeUid,
        customerName: customerProfile?.name || 'Customer',
        customerPhone: customerProfile?.phone || '',
        amount: amt,
        utr: cleanUtr,
        screenshot: screenshotData || '',
        status: 'PENDING',
        createdAt: Date.now(),
      });
      setIsDepositOpen(false);
      showToast('✅ Deposit request sent to Admin for verification!', 'success');
    } catch (err) {
      showToast('Deposit failed.', 'danger');
    } finally {
      setIsSubmittingAction(false);
    }
  };

  const handleWalletWithdrawSubmit = async (amt: number, upiIdRaw: string) => {
    if (isSubmittingAction || !activeUid) return;
    const bal = Number(customerProfile?.walletBalance || 0);
    if (amt > bal) return showToast('Insufficient wallet balance!', 'danger');

    setIsSubmittingAction(true);
    try {
      await runTransaction(ref(db, `customers/${activeUid}/walletBalance`), (b) => Math.max(0, Number(b || 0) - amt));
      await push(ref(db, `walletTransactions/${activeUid}`), {
        type: 'DEBIT',
        amount: amt,
        note: `Withdrawal to ${upiIdRaw}`,
        createdAt: Date.now(),
      });
      await push(ref(db, 'walletRequests'), {
        type: 'WITHDRAW',
        customerUid: activeUid,
        customerName: customerProfile?.name || 'Customer',
        customerPhone: customerProfile?.phone || '',
        amount: amt,
        upiId: upiIdRaw,
        status: 'PENDING',
        createdAt: Date.now(),
      });
      setIsWithdrawOpen(false);
      showToast('✅ Withdrawal request submitted to Admin!', 'success');
    } catch (err) {
      showToast('Withdrawal failed.', 'danger');
    } finally {
      setIsSubmittingAction(false);
    }
  };

  const handleLogout = () => {
    setCartItems([]);
    setCustomerProfile(null);
    setCachedOrders({});
    setWalletTransactions({});
    setMyFeedbacks({});
    if (currentUser) void signOut(auth);
    showToast('👋 Signed out successfully.', 'info');
  };

  const filteredProducts = useMemo<MenuItem[]>(() => {
    const query = searchQuery.toLowerCase().trim();
    const list: MenuItem[] = [];
    Object.entries(allMenus).forEach(([storeId, storeItems]) => {
      const store = stores[storeId];
      if (store && store.approved === true && store.suspended !== true && store.isOpen !== false) {
        Object.entries(storeItems || {}).forEach(([itemId, item]) => {
          if (item.available !== false && item.adminApproved === true) {
            list.push({ ...item, itemId, storeId, storeName: store.name });
          }
        });
      }
    });

    const filtered = list.filter((item) => {
      if (
        currentCategoryFilter !== 'ALL' &&
        currentCategoryFilter !== 'ALL_STORES' &&
        !doesItemMatchCategory(item, currentCategoryFilter, categories, customerProfile?.favorites)
      ) {
        return false;
      }
      if (query && !matchesKeywordSearch(item, item.storeName || '', query)) return false;
      return true;
    });

    return sortProductsByProximity(filtered, stores, activeCustomerLat, activeCustomerLng, {
      radiusKm: nearbyRadiusKm,
      prioritizeNearby: prioritizeNearbyStores,
      searchQuery: query,
    });
  }, [activeCustomerLat, activeCustomerLng, allMenus, categories, currentCategoryFilter, customerProfile?.favorites, nearbyRadiusKm, prioritizeNearbyStores, searchQuery, stores]);

  const approvedStores = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    const matching = Object.entries(stores).filter(([storeId, s]) => {
      if (s.approved !== true || s.suspended === true) return false;
      if (!query) return true;
      return (s.name || '').toLowerCase().includes(query) || (s.cuisine || '').toLowerCase().includes(query);
    });
    return sortStoresByProximity(matching, activeCustomerLat, activeCustomerLng, {
      radiusKm: nearbyRadiusKm,
      prioritizeNearby: prioritizeNearbyStores,
    });
  }, [activeCustomerLat, activeCustomerLng, nearbyRadiusKm, prioritizeNearbyStores, searchQuery, stores]);

  const groupedOrders = useMemo(() => groupCustomerOrders(cachedOrders), [cachedOrders]);
  const favCount = Object.keys(customerProfile?.favorites || {}).length;
  const totalCartCount = cartItems.reduce((acc, curr) => acc + curr.qty, 0);
  const totalCartSubtotal = cartItems.reduce((acc, curr) => acc + curr.price * curr.qty, 0);
  const referralCode = customerProfile?.referralCode || (activeUid ? 'GB' + activeUid.slice(0, 6).toUpperCase() : 'GBUSER');

  return (
    <>
      <LivePushBanner
        notification={activeBanner}
        onDismiss={dismissBanner}
        onOpen={(notif) => {
          dismissBanner();
          markNotificationRead(notif.id);
          if (notif.targetTab) switchNav(notif.targetTab);
        }}
      />

      <div id="toast-container">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span>{t.msg}</span>
          </div>
        ))}
      </div>

      <div className="app-viewport">
        <OfflineIndicator />

        {authReady && !isLoggedIn && (
          <AuthScreen
            brandName={settings.appBrandName || 'Chutki'}
            allowReferrals={allowReferrals}
            referrerBonus={referrerBonus}
            refereeBonus={refereeBonus}
            showToast={showToast}
            onDetectedGps={(lat, lng, link) => {
              setDetectedLat(lat);
              setDetectedLng(lng);
              setDetectedLocationLink(link);
            }}
            detectedLat={detectedLat}
            detectedLng={detectedLng}
            detectedLocationLink={detectedLocationLink}
          />
        )}

        {/* HEADER */}
        <header className="app-header">
          <div className="header-top-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('tap');
                  setCurrentCategoryFilter('ALL');
                  switchNav('home');
                }}
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '11px',
                  overflow: 'hidden',
                  border: 'none',
                  padding: 0,
                  flexShrink: 0,
                  cursor: 'pointer',
                  background: '#029b02',
                }}
              >
                <img
                  src="/assets/aistudio/IMG-20261115-WA0008_6f19703a.jpg"
                  alt={`${appBrandName} Logo`}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </button>
              <div style={{ minWidth: 0 }}>
                <div className="express-delivery-badge">
                  <span>{settings.expressEtaText || '⚡ 15 MINS EXPRESS'}</span>
                  <span className="express-pill">{settings.expressLocalBadge || 'LOCAL'}</span>
                </div>
                <button
                  type="button"
                  className="delivery-location-pill"
                  onClick={() => switchNav('profile')}
                >
                  <strong>{customerProfile?.address ? customerProfile.address.split(',')[0].slice(0, 24) : 'Gossaigaon Town'}</strong>
                  <i className="fa-solid fa-chevron-down" style={{ fontSize: '0.75rem', color: '#64748b' }} />
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
              <button
                type="button"
                className="header-icon-btn"
                onClick={() => {
                  triggerHaptic('tap');
                  setCurrentCategoryFilter('FAVORITES');
                  switchNav('home');
                }}
              >
                <i className="fa-solid fa-heart" style={{ color: 'var(--danger)' }} />
                {favCount > 0 && <span className="fav-dot-count">{favCount}</span>}
              </button>
              <button
                type="button"
                className="header-icon-btn"
                onClick={() => {
                  triggerHaptic('tap');
                  setIsInboxOpen(true);
                }}
              >
                <i className="fa-solid fa-bell" style={{ color: pushPermission === 'granted' ? 'var(--brand-green)' : '#475569' }} />
                {unreadCount > 0 && <span className="fav-dot-count">{unreadCount}</span>}
              </button>
              <button type="button" className="header-icon-btn" onClick={() => switchNav('wallet', true, true)}>
                <i className="fa-solid fa-wallet" style={{ color: 'var(--brand-green)' }} />
              </button>
              <button type="button" className="header-icon-btn" onClick={() => switchNav('profile', true, true)}>
                <i className="fa-solid fa-user" />
              </button>
            </div>
          </div>

          <div className="quick-search-wrap">
            <i className="fa-solid fa-magnifying-glass" />
            <input
              type="text"
              id="store-search-input"
              className="quick-search-input"
              placeholder={settings.searchPlaceholder || 'Search vegetables, atta, milk across stores...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {allowVoiceSearch && (
              <button
                type="button"
                className={`voice-mic-btn ${isVoiceListening ? 'listening' : ''}`}
                onClick={startVoiceSearch}
                title="Voice Search"
              >
                <i className="fa-solid fa-microphone" />
              </button>
            )}
          </div>
        </header>

        {/* CATEGORY STRIP */}
        <div className="categories-circular-strip" id="categories-strip">
          {categories.map((cat) => {
            const isActive = currentCategoryFilter === cat.id;
            return (
              <button
                type="button"
                key={cat.id}
                className={`cat-item ${isActive ? 'active' : ''}`}
                onClick={() => {
                  triggerHaptic('tap');
                  setCurrentCategoryFilter(cat.id);
                }}
              >
                <div className="cat-icon-circle">{cat.icon || '🛒'}</div>
                <span className="cat-label">{cat.name}</span>
              </button>
            );
          })}
        </div>

        {/* TAB CONTENTS */}
        {activeTab === 'home' && (
          <HomeTab
            settings={settings}
            freeDeliveryMinOrder={freeDeliveryMinOrder}
            currentCategoryFilter={currentCategoryFilter}
            categories={categories}
            filteredProducts={filteredProducts}
            approvedStores={approvedStores}
            allMenus={allMenus}
            favorites={customerProfile?.favorites}
            favoriteStores={customerProfile?.favoriteStores}
            allowFavoriteStores={allowFavoriteStores}
            allowStoreQuickAdd={allowStoreQuickAdd}
            showStockBadges={showStockBadges}
            enforceStockLimits={enforceStockLimits}
            customerLat={activeCustomerLat}
            customerLng={activeCustomerLng}
            nearbyRadiusKm={nearbyRadiusKm}
            prioritizeNearbyStores={prioritizeNearbyStores}
            searchQuery={searchQuery}
            isDetectingGps={isDetectingHomeGps}
            isLiveGpsTracking={isLiveGpsTracking}
            onDetectLiveGps={handleHomeGpsDetect}
            getItemQuantityInCart={getItemQuantityInCart}
            onFilterCategory={setCurrentCategoryFilter}
            onToggleFavorite={toggleFavoriteItem}
            onToggleFavoriteStore={toggleFavoriteStore}
            onOpenProductDetail={(sId, iId) => setDetailItemRef({ storeId: sId, itemId: iId })}
            onUpdateCart={updateCartQtySafe}
            onOpenStoreModal={(sId) => setMenuStoreId(sId)}
            pushPermission={pushPermission}
            pushPromptDismissed={promptDismissed}
            onEnablePush={() => void enablePushNotifications()}
            onDismissPushPrompt={dismissPrompt}
          />
        )}

        {activeTab === 'orders' && (
          <OrdersTab
            groupedOrders={groupedOrders}
            cachedOrders={cachedOrders}
            stores={stores}
            deliveryPartners={deliveryPartners}
            timelineTimestamps={observedStatusTimestamps}
            gmpQuotaExceeded={gmpQuotaExceeded}
            brandName={appBrandName}
            allowRiderTip={allowRiderTip}
            allowRefundRequests={allowRefundRequests}
            allowDeliveryQr={allowDeliveryQr}
            onOpenTipRider={(groupKey) => setTipRiderGroupKey(groupKey)}
            onOpenRefundOrder={(order) => setRefundOrderTarget(order)}
            onOpenCancelOrder={(groupKey) => setCancelGroupKey(groupKey)}
            onReorderOrder={(order) => {
              const res = mergePastOrderIntoCart(cartItems, order, stores, allMenus);
              setCartItems(res.nextCart);
              setIsCheckoutOpen(true);
            }}
          />
        )}

        {activeTab === 'wallet' && (
          <WalletTab
            walletBalance={Number(customerProfile?.walletBalance || 0)}
            totalCashbackEarned={Number(customerProfile?.totalCashbackEarned || 0)}
            cashbackPercent={cashbackPercent}
            allowCashback={allowCashback}
            minDeposit={minCustomerDeposit}
            maxDeposit={maxCustomerDeposit}
            minWithdraw={minCustomerWithdraw}
            maxWithdraw={maxCustomerWithdraw}
            allowReferrals={allowReferrals}
            referrerBonus={referrerBonus}
            refereeBonus={refereeBonus}
            referralCode={referralCode}
            transactions={walletTransactions}
            onOpenDeposit={() => setIsDepositOpen(true)}
            onOpenWithdraw={() => setIsWithdrawOpen(true)}
            onCopyReferral={() => {
              navigator.clipboard?.writeText(referralCode);
              showToast(`Referral code ${referralCode} copied!`, 'success');
            }}
          />
        )}

        {activeTab === 'profile' && (
          <ProfileTab
            profile={customerProfile || {}}
            userEmail={currentUser?.email || customerProfile?.email || ''}
            referralCode={referralCode}
            hasGpsPinned={Boolean(detectedLat && detectedLng)}
            isDetectingGps={isDetectingProfileGps}
            settings={settings}
            myFeedbacks={myFeedbacks}
            pushPermission={pushPermission}
            unreadNotifications={unreadCount}
            isPlusActive={isPlusActive}
            isActivatingPlus={isActivatingPlus}
            allowChutkiPlus={allowChutkiPlus}
            plusPlanPrice={plusPlanPrice}
            plusValidityDays={plusValidityDays}
            onActivatePlus={() => void handleActivateChutkiPlus()}
            onDetectGps={handleProfileGps}
            onSaveProfile={handleSaveProfile}
            onOpenFeedback={() => setIsFeedbackOpen(true)}
            onEnablePush={() => void enablePushNotifications()}
            onSendTestPush={() => void sendTestPush()}
            onOpenNotificationInbox={() => setIsInboxOpen(true)}
            onSendPasswordReset={async () => {
              if (currentUser?.email) {
                await sendPasswordResetEmail(auth, currentUser.email);
                showToast(`📧 Reset link sent to ${currentUser.email}`, 'success');
              }
            }}
            onLogout={handleLogout}
          />
        )}

        {/* FLOATING CART BAR */}
        {totalCartCount > 0 && (
          <button
            type="button"
            id="cart-floating-bar"
            onClick={() => {
              triggerHaptic('tap');
              setIsCheckoutOpen(true);
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '1.3rem' }}>🛍️</span>
              <div>
                <span id="floating-cart-count" style={{ display: 'block', fontSize: '0.84rem', fontWeight: 900 }}>
                  {totalCartCount} ITEM{totalCartCount > 1 ? 'S' : ''}
                </span>
                <span id="floating-cart-total" style={{ fontSize: '1rem', fontWeight: 900 }}>
                  ₹{totalCartSubtotal.toFixed(0)}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.92rem', fontWeight: 900 }}>
              <span>View Basket</span>
              <i className="fa-solid fa-chevron-right" style={{ fontSize: '0.8rem' }} />
            </div>
          </button>
        )}

        {/* BOTTOM NAV */}
        <nav className="bottom-nav">
          <button type="button" className={`nav-btn ${activeTab === 'home' ? 'active' : ''}`} onClick={() => switchNav('home', true, true)}>
            <i className="fa-solid fa-bag-shopping" />
            <span>Bazar</span>
          </button>
          <button type="button" className={`nav-btn ${activeTab === 'orders' ? 'active' : ''}`} onClick={() => switchNav('orders', true, true)}>
            <i className="fa-solid fa-receipt" />
            <span>Orders</span>
          </button>
          <button type="button" className={`nav-btn ${activeTab === 'wallet' ? 'active' : ''}`} onClick={() => switchNav('wallet', true, true)}>
            <i className="fa-solid fa-wallet" />
            <span>Wallet</span>
          </button>
          <button type="button" className={`nav-btn ${activeTab === 'profile' ? 'active' : ''}`} onClick={() => switchNav('profile', true, true)}>
            <i className="fa-solid fa-user" />
            <span>Profile</span>
          </button>
        </nav>

        {/* MODALS */}
        <StoreMenuModal
          storeId={menuStoreId}
          stores={stores}
          allMenus={allMenus}
          favorites={customerProfile?.favorites}
          favoriteStores={customerProfile?.favoriteStores}
          showStockBadges={showStockBadges}
          enforceStockLimits={enforceStockLimits}
          allowFavoriteStores={allowFavoriteStores}
          getItemQuantityInCart={getItemQuantityInCart}
          onClose={() => setMenuStoreId(null)}
          onToggleFavorite={toggleFavoriteItem}
          onToggleFavoriteStore={toggleFavoriteStore}
          onOpenProductDetail={(sId, iId) => setDetailItemRef({ storeId: sId, itemId: iId })}
          onUpdateCart={updateCartQtySafe}
        />

        <ProductDetailModal
          detailRef={detailItemRef}
          stores={stores}
          allMenus={allMenus}
          favorites={customerProfile?.favorites}
          showStockBadges={showStockBadges}
          enforceStockLimits={enforceStockLimits}
          getItemQuantityInCart={getItemQuantityInCart}
          onClose={() => setDetailItemRef(null)}
          onToggleFavorite={toggleFavoriteItem}
          onOpenProductDetail={(sId, iId) => setDetailItemRef({ storeId: sId, itemId: iId })}
          onUpdateCart={updateCartQtySafe}
        />

        <CheckoutModal
          isOpen={isCheckoutOpen}
          cartItems={cartItems}
          stores={stores}
          walletBalance={Number(customerProfile?.walletBalance || 0)}
          adminUpiId={adminUpiId}
          usedUtrs={Array.from(collectKnownUtrs(cachedOrders, localUsedUtrs))}
          baseDeliveryCharge={baseDeliveryCharge}
          freeDeliveryMinOrder={freeDeliveryMinOrder}
          handlingFee={handlingFee}
          isPlusActive={isPlusActive}
          allowChutkiPlus={allowChutkiPlus}
          plusPlanPrice={plusPlanPrice}
          allowCashback={allowCashback}
          cashbackPercent={cashbackPercent}
          allowRiderTip={allowRiderTip}
          riderTipOptions={riderTipOptions}
          allowScheduledDelivery={allowScheduledDelivery}
          customDeliverySlots={customDeliverySlots}
          allowCod={allowCod}
          allowUpi={allowUpi}
          allowCardPayment={allowCardPayment}
          allowWalletPayment={allowWalletPayment}
          allowCoupons={allowCoupons}
          cmsCouponCode={cmsCouponCode}
          cmsCouponDiscount={cmsCouponDiscount}
          cmsCouponMinOrder={cmsCouponMinOrder}
          minOrderAmount={minOrderAmount}
          initialAddress={customerProfile?.address || ''}
          initialPhone={customerProfile?.phone || ''}
          hasGpsAttached={Boolean(detectedLat && detectedLng)}
          isFetchingGps={isFetchingCheckoutGps}
          isPlacingOrder={isPlacingOrder}
          isActivatingPlus={isActivatingPlus}
          onClose={() => setIsCheckoutOpen(false)}
          onUpdateCart={(itemId, storeId, change) => updateCartQtySafe(itemId, storeId, change)}
          onFetchGps={handleCheckoutGps}
          onActivatePlus={() => void handleActivateChutkiPlus()}
          onPlaceOrder={(p) => void handlePlaceOrder(p)}
          showToast={showToast}
        />

        <WalletDepositModal
          isOpen={isDepositOpen}
          adminUpiId={adminUpiId}
          usedUtrs={Array.from(collectKnownUtrs(cachedOrders, localUsedUtrs))}
          minDeposit={minCustomerDeposit}
          maxDeposit={maxCustomerDeposit}
          isSubmitting={isSubmittingAction}
          onClose={() => setIsDepositOpen(false)}
          onSubmit={(amt, utr, ss) => void handleWalletDepositSubmit(amt, utr, ss)}
          showToast={showToast}
        />

        <WalletWithdrawModal
          isOpen={isWithdrawOpen}
          minWithdraw={minCustomerWithdraw}
          maxWithdraw={maxCustomerWithdraw}
          isSubmitting={isSubmittingAction}
          onClose={() => setIsWithdrawOpen(false)}
          onSubmit={(amt, upi) => void handleWalletWithdrawSubmit(amt, upi)}
        />

        <TipRiderModal
          group={tipRiderGroupKey ? groupedOrders.find((g) => g.groupKey === tipRiderGroupKey) || null : null}
          riderName="Delivery Partner"
          walletBalance={Number(customerProfile?.walletBalance || 0)}
          tipOptions={riderTipOptions}
          isSubmitting={isSubmittingAction}
          onClose={() => setTipRiderGroupKey(null)}
          onSubmitTip={() => showToast('Tip added!', 'success')}
        />

        <RefundRequestModal
          order={refundOrderTarget}
          storeName="Store"
          isSubmitting={isSubmittingAction}
          onClose={() => setRefundOrderTarget(null)}
          onSubmitRefund={() => showToast('Refund request submitted.', 'success')}
        />

        <FeedbackModal
          isOpen={isFeedbackOpen}
          isSubmitting={isSubmittingAction}
          onClose={() => setIsFeedbackOpen(false)}
          onSubmit={(sub, msg) => {
            push(ref(db, 'feedbacks'), {
              role: 'CUSTOMER',
              uid: activeUid,
              name: customerProfile?.name || 'Customer',
              phone: customerProfile?.phone || '',
              subject: sub,
              message: msg,
              status: 'OPEN',
              createdAt: Date.now(),
            });
            setIsFeedbackOpen(false);
            showToast('Feedback sent!', 'success');
          }}
        />

        <CancelOrderModal
          groupKey={cancelGroupKey}
          isSubmitting={isSubmittingAction}
          onClose={() => setCancelGroupKey(null)}
          onConfirmCancel={(gk, r) => {
            setCancelGroupKey(null);
            showToast('Order cancelled', 'info');
          }}
        />

        <NotificationInboxModal
          isOpen={isInboxOpen}
          notifications={notifications}
          permission={pushPermission}
          onClose={() => setIsInboxOpen(false)}
          onEnablePush={() => void enablePushNotifications()}
          onSendTestPush={() => void sendTestPush()}
          onMarkRead={markNotificationRead}
          onMarkAllRead={markAllRead}
          onClearAll={clearInbox}
          onSelectTargetTab={(tab) => switchNav(tab)}
        />
      </div>
    </>
  );
}
