import { useCallback, useEffect, useRef, useState } from 'react';
import { ref, update } from 'firebase/database';
import { getToken, onMessage } from 'firebase/messaging';
import { db, getFirebaseMessagingSafe } from '../firebase';
import type { AppNotification, TabKey } from '../types/bazar';
import { prune30DayExpiredNotifications } from '../utils/dataRetention';

const INBOX_STORAGE_KEY = 'gb_push_inbox_v1';
const PROMPT_DISMISSED_KEY = 'gb_push_prompt_dismissed_v1';

function loadSavedInbox(): AppNotification[] {
  try {
    const raw = localStorage.getItem(INBOX_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const { retainedNotifications } = prune30DayExpiredNotifications(parsed as AppNotification[]);
    return retainedNotifications.slice(0, 40);
  } catch {
    return [];
  }
}

export type PushPermissionState = NotificationPermission | 'unsupported';

const isNativeApp = (): boolean =>
  typeof (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor !== 'undefined' &&
  Boolean((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());

export function usePushNotifications(
  userUid: string | null,
  onNavigateTab?: (tab: TabKey) => void
) {
  const [permission, setPermission] = useState<PushPermissionState>(() => {
    if (typeof window === 'undefined') return 'unsupported';
    if (isNativeApp()) return 'default';
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
  });

  const [notifications, setNotifications] = useState<AppNotification[]>(loadSavedInbox);
  const [promptDismissed, setPromptDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PROMPT_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [fcmToken, setFcmToken] = useState<string>('');
  const [activeBanner, setActiveBanner] = useState<AppNotification | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    };
  }, []);

  // Native Android permissions check on mount
  useEffect(() => {
    if (isNativeApp()) {
      void import('@capacitor/local-notifications').then(({ LocalNotifications }) => {
        LocalNotifications.checkPermissions()
          .then((status) => {
            if (status.display === 'granted') {
              setPermission('granted');
            }
          })
          .catch(() => {});
      });
    }
  }, []);

  const persistInbox = useCallback((items: AppNotification[]) => {
    try {
      const { retainedNotifications } = prune30DayExpiredNotifications(items);
      localStorage.setItem(INBOX_STORAGE_KEY, JSON.stringify(retainedNotifications.slice(0, 40)));
    } catch {
      // Ignore storage quota
    }
  }, []);

  const showNativeNotification = useCallback(
    async (notif: AppNotification) => {
      // 1. Android APK Native Notification with Custom Chutki Cart Icon
      if (isNativeApp()) {
        try {
          const { LocalNotifications } = await import('@capacitor/local-notifications');
          await LocalNotifications.schedule({
            notifications: [
              {
                id: Math.floor(Math.random() * 100000),
                title: notif.title,
                body: notif.body,
                smallIcon: 'ic_stat_chutki',
                iconColor: '#0c831f',
                largeIcon: 'ic_launcher_round',
                schedule: { at: new Date(Date.now() + 100) },
              },
            ],
          });
          return;
        } catch {
          // Fallback
        }
      }

      // 2. Web Browser Notification
      if (typeof window === 'undefined' || !('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;

      try {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          if (reg && typeof reg.showNotification === 'function') {
            await reg.showNotification(notif.title, {
              body: notif.body,
              icon: '/pwa-192x192.png',
              badge: '/pwa-192x192.png',
              tag: notif.tag,
              data: {
                url: `/?tab=${notif.targetTab || 'orders'}`,
                targetTab: notif.targetTab || 'orders',
              },
            });
            return;
          }
        }
        new Notification(notif.title, {
          body: notif.body,
          icon: '/pwa-192x192.png',
          tag: notif.tag,
        });
      } catch {
        // Fallback
      }
    },
    []
  );

  const dismissBanner = useCallback(() => {
    if (bannerTimerRef.current) {
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }
    setActiveBanner(null);
  }, []);

  const pushNotification = useCallback(
    (notif: AppNotification, showSystemAlert = true) => {
      let wasAdded = false;
      setNotifications((prev) => {
        if (prev.some((n) => n.id === notif.id)) return prev;
        wasAdded = true;
        const next = [notif, ...prev].slice(0, 40);
        persistInbox(next);
        return next;
      });
      if (showSystemAlert) {
        if (wasAdded || notif.type === 'ORDER') {
          setActiveBanner(notif);
          if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
          bannerTimerRef.current = setTimeout(() => {
            setActiveBanner((cur) => (cur?.id === notif.id ? null : cur));
          }, 5500);
        }
        void showNativeNotification(notif);
      }
    },
    [persistInbox, showNativeNotification]
  );

  const markNotificationRead = useCallback(
    (notifId: string) => {
      setNotifications((prev) => {
        const next = prev.map((n) => (n.id === notifId ? { ...n, read: true } : n));
        persistInbox(next);
        return next;
      });
    },
    [persistInbox]
  );

  const markAllRead = useCallback(() => {
    setNotifications((prev) => {
      const next = prev.map((n) => ({ ...n, read: true }));
      persistInbox(next);
      return next;
    });
  }, [persistInbox]);

  const clearInbox = useCallback(() => {
    setNotifications([]);
    persistInbox([]);
    dismissBanner();
  }, [dismissBanner, persistInbox]);

  const dismissPrompt = useCallback(() => {
    setPromptDismissed(true);
    try {
      localStorage.setItem(PROMPT_DISMISSED_KEY, '1');
    } catch {
      // Ignore
    }
  }, []);

  const syncFcmToken = useCallback(async () => {
    if (!userUid) return;
    try {
      const messaging = await getFirebaseMessagingSafe();
      if (!messaging || !('serviceWorker' in navigator)) return;
      const reg = await navigator.serviceWorker.ready;
      const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
      const token = vapidKey
        ? await getToken(messaging, { vapidKey, serviceWorkerRegistration: reg })
        : await getToken(messaging, { serviceWorkerRegistration: reg }).catch(() => '');
      if (token) {
        setFcmToken(token);
        await update(ref(db, `customers/${userUid}`), {
          fcmToken: token,
          pushEnabled: true,
        });
      } else {
        await update(ref(db, `customers/${userUid}`), {
          pushEnabled: true,
        });
      }
    } catch {
      if (userUid) {
        void update(ref(db, `customers/${userUid}`), { pushEnabled: true }).catch(() => {});
      }
    }
  }, [userUid]);

  const enablePushNotifications = useCallback(async (): Promise<{
    granted: boolean;
    message: string;
  }> => {
    // 1. Android APK Native Notification Permission
    if (isNativeApp()) {
      try {
        const { LocalNotifications } = await import('@capacitor/local-notifications');
        const req = await LocalNotifications.requestPermissions();
        if (req.display === 'granted') {
          setPermission('granted');
          dismissPrompt();
          const welcomeNotif: AppNotification = {
            id: `welcome_${Date.now()}`,
            title: '🔔 Chutki Alerts Active!',
            body: 'Aapko live order status, rider delivery PIN aur offers ke alerts milenge.',
            tag: 'gb-welcome-push',
            type: 'SYSTEM',
            targetTab: 'home',
            createdAt: Date.now(),
            read: false,
          };
          pushNotification(welcomeNotif, true);
          return { granted: true, message: '🔔 Push notifications enabled!' };
        }
        return { granted: false, message: 'Notification permission denied in phone settings.' };
      } catch (err) {
        return { granted: false, message: err instanceof Error ? err.message : 'Permission failed' };
      }
    }

    // 2. Web Browser Permission
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setPermission('unsupported');
      return {
        granted: false,
        message: 'Push notifications are not supported on this browser.',
      };
    }

    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result === 'granted') {
        dismissPrompt();
        await syncFcmToken();
        const welcomeNotif: AppNotification = {
          id: `welcome_${Date.now()}`,
          title: '🔔 Chutki Alerts Active!',
          body: 'You will now receive live order updates, rider arrival PIN & deal alerts.',
          tag: 'gb-welcome-push',
          type: 'SYSTEM',
          targetTab: 'home',
          createdAt: Date.now(),
          read: false,
        };
        pushNotification(welcomeNotif, true);
        return {
          granted: true,
          message: '🔔 Push notifications enabled! Check your notification tray.',
        };
      }
      return {
        granted: false,
        message:
          result === 'denied'
            ? 'Notification permission blocked in browser settings.'
            : 'Notification permission dismissed.',
      };
    } catch (err) {
      return {
        granted: false,
        message: err instanceof Error ? err.message : 'Unable to enable notifications.',
      };
    }
  }, [dismissPrompt, pushNotification, syncFcmToken]);

  const sendTestPush = useCallback(async () => {
    if (permission !== 'granted') {
      return enablePushNotifications();
    }
    const testNotif: AppNotification = {
      id: `test_${Date.now()}`,
      title: '⚡ 15-Min Express Order Alert',
      body: 'Notifications working smoothly! Rider updates will arrive here.',
      tag: `gb-test-${Date.now()}`,
      type: 'ORDER',
      targetTab: 'orders',
      createdAt: Date.now(),
      read: false,
    };
    pushNotification(testNotif, true);
    return { granted: true, message: '🔔 Test notification sent!' };
  }, [enablePushNotifications, permission, pushNotification]);

  return {
    permission,
    fcmToken,
    notifications,
    unreadCount: notifications.filter((n) => !n.read).length,
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
  };
}
