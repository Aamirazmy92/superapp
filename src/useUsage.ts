import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanUsage, UsageProvider } from './types';
import {
  usageAlerts,
  usageWindows,
  type UsageAlert,
  type UsageAlertState,
  type UsageThresholds,
} from './usageModel';

// The main process caches readings, so these only decide how soon a change can show.
const ACTIVE_POLL_MS = 60_000;
const IDLE_POLL_MS = 3 * 60_000;
// Give the provider a moment to count a reply that just finished.
const AFTER_TURN_MS = 4_000;
const alertStorageKey = 'usage-alerts';

export type UsageReadings = Partial<Record<UsageProvider, PlanUsage>>;

function readAlertState(): UsageAlertState {
  try {
    const value = JSON.parse(localStorage.getItem(alertStorageKey) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function writeAlertState(state: UsageAlertState) {
  try {
    localStorage.setItem(alertStorageKey, JSON.stringify(state));
  } catch {
    /* Warnings may repeat after a restart; nothing else depends on this. */
  }
}

/**
 * Plan usage for the whole window: shown at once from the last saved reading,
 * then polled faster while a Claude or Codex agent is replying, paused while
 * the app is hidden, and re-read shortly after each reply finishes.
 */
export function useUsage({
  active,
  refreshSignal,
  onAlerts,
  thresholds,
}: {
  active: boolean;
  refreshSignal: number;
  onAlerts: (alerts: UsageAlert[]) => void;
  thresholds: UsageThresholds;
}) {
  const [usage, setUsage] = useState<UsageReadings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const alertsRef = useRef(onAlerts);
  const usageRef = useRef(usage);
  usageRef.current = usage;
  alertsRef.current = onAlerts;
  const thresholdsRef = useRef(thresholds);
  thresholdsRef.current = thresholds;
  const load = useCallback((mode?: 'cached' | 'force'): Promise<void> => {
    if (mode !== 'cached' && pending.current) return pending.current;
    const task = (async () => {
      if (!window.workspace?.getUsage) return;
      if (mode !== 'cached') setLoading(true);
      try {
        const next = await window.workspace.getUsage(mode);
        if (!mounted.current) return;
        if (mode !== 'cached') setError(null);
        setUsage((previous) => (mode === 'cached' && previous ? previous : next));
        if (mode === 'cached') return;
        const { state, alerts } = usageAlerts(
          readAlertState(),
          next,
          Date.now(),
          thresholdsRef.current,
        );
        writeAlertState(state);
        if (alerts.length) alertsRef.current(alerts);
      } catch {
        if (mounted.current && mode !== 'cached') {
          setError('Usage could not be refreshed. Try again.');
          setUsage(
            (previous) =>
              previous &&
              Object.fromEntries(
                Object.entries(previous).map(([key, item]) => [
                  key,
                  item?.status === 'ok' ? { ...item, status: 'stale' as const } : item,
                ]),
              ),
          );
        }
      } finally {
        if (mounted.current && mode !== 'cached') setLoading(false);
      }
    })();
    if (mode !== 'cached') {
      pending.current = task;
      void task.finally(() => {
        if (pending.current === task) pending.current = null;
      });
    }
    return task;
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load('cached').then(() => {
      if (mounted.current && !document.hidden) return load();
    });
    return () => {
      mounted.current = false;
    };
  }, [load]);
  useEffect(() => {
    const timer = setInterval(
      () => {
        if (!document.hidden) void load();
      },
      active ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    );
    const visible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [load, active]);
  const lastSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === lastSignal.current) return;
    lastSignal.current = refreshSignal;
    const available = Object.values(usageRef.current || {}).flatMap((item) =>
      item?.refreshAt ? [item.refreshAt] : [],
    );
    const delay = Math.max(
      AFTER_TURN_MS,
      available.length ? Math.min(...available) - Date.now() : 0,
    );
    const timer = setTimeout(
      () => {
        if (!document.hidden) void load('force');
      },
      Math.min(delay, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [refreshSignal, load]);
  // Recheck near a reset instead of leaving an expired limit up for an idle poll.
  useEffect(() => {
    const at = Date.now();
    const resets = Object.values(usage || {}).flatMap((item) =>
      item
        ? usageWindows(item).flatMap(({ window }) =>
            window.resetsAt
              ? [
                  Math.max(
                    window.resetsAt > at ? window.resetsAt + 100 : at + 30_000,
                    item.refreshAt || 0,
                  ),
                ]
              : [],
          )
        : [],
    );
    if (!resets.length) return;
    const timer = setTimeout(
      () => {
        if (!document.hidden) void load('force');
      },
      Math.min(Math.max(0, Math.min(...resets) - at + 100), 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [usage, load]);
  const refresh = useCallback(() => load('force'), [load]);
  // CLI notifications are sparse updates: fetch a validated full snapshot
  // instead of treating an absent field as zero or dropping another window.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.workspace?.onUsageChanged?.(() => {
      if (document.hidden) return;
      clearTimeout(timer);
      const at = Date.now();
      const available = Object.values(usageRef.current || {}).flatMap((item) =>
        item?.refreshAt ? [item.refreshAt] : [],
      );
      timer = setTimeout(
        () => {
          if (!document.hidden) void load('force');
        },
        Math.min(
          2_147_483_647,
          Math.max(AFTER_TURN_MS, available.length ? Math.min(...available) - at : 0),
        ),
      );
    });
    return () => {
      unsubscribe?.();
      clearTimeout(timer);
    };
  }, [load]);
  return { usage, loading, error, refresh };
}
