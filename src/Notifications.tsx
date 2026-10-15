import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Bell, Check, CheckCheck, Trash2 } from './icons';
import { AnimatePresence } from 'motion/react';
import { AnchoredPopover } from './AnchoredPopover';

export type NotificationItem = {
  id: string;
  title: string;
  detail: string;
  timestamp: number;
  read: boolean;
  success: boolean;
};
const storageKey = 'task-notifications';
const limit = 40;
const visibleLimit = 10;

function relativeTime(timestamp: number) {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function groupByDay(items: NotificationItem[]) {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const day = 86400000;
  const groups: { label: string; items: NotificationItem[] }[] = [];
  for (const item of items) {
    const label =
      item.timestamp >= startOfToday
        ? 'Today'
        : item.timestamp >= startOfToday - day
          ? 'Yesterday'
          : 'Earlier';
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

function readStored(): NotificationItem[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(value)
      ? (
          value.filter(
            (item) =>
              item &&
              typeof item.id === 'string' &&
              typeof item.title === 'string' &&
              typeof item.detail === 'string' &&
              typeof item.timestamp === 'number' &&
              typeof item.read === 'boolean' &&
              typeof item.success === 'boolean',
          ) as NotificationItem[]
        ).slice(0, limit)
      : [];
  } catch {
    return [];
  }
}

/** Finished-task notifications, newest first, remembered on this device. */
export function useNotifications() {
  const [items, setItems] = useState(readStored);
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(items));
  }, [items]);
  const push = useCallback(
    (item: Omit<NotificationItem, 'read'>) =>
      setItems((previous) => [{ ...item, read: false }, ...previous].slice(0, limit)),
    [],
  );
  return { items, setItems, push };
}

export function NotificationsMenu({
  items,
  setItems,
  open,
  onOpenChange,
}: {
  items: NotificationItem[];
  setItems: React.Dispatch<React.SetStateAction<NotificationItem[]>>;
  open: boolean;
  onOpenChange: (open: boolean | ((open: boolean) => boolean)) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const unread = items.filter((item) => !item.read).length;
  useEffect(() => {
    if (!open) return;
    const closeWhenClickedOutside = (event: PointerEvent) => {
      const target = event.target;
      if (wrapRef.current?.contains(target as Node)) return;
      if (target instanceof Element && target.closest('.notification-popover')) return;
      onOpenChange(false);
    };
    document.addEventListener('pointerdown', closeWhenClickedOutside);
    return () => document.removeEventListener('pointerdown', closeWhenClickedOutside);
  }, [open]);
  return (
    <div className="notification-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        className={`notification-trigger ${open ? 'active' : ''}`}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        aria-expanded={open}
        title="Task notifications"
        onClick={() => onOpenChange((value) => !value)}
      >
        <Bell size={16} />
        {unread > 0 && <span className="notification-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      <AnimatePresence>
        {open && (
          <AnchoredPopover
            anchor={triggerRef.current}
            align="window"
            gap={14}
            className="notification-popover"
            role="region"
            label="Task notifications"
          >
            <header className="notification-popover-header">
              <div>
                <strong>Notifications</strong>
                {unread > 0 && <em className="notification-count">{unread} new</em>}
              </div>
              <button
                className="notification-mark-read"
                disabled={!unread}
                onClick={() => setItems((current) => current.map((item) => ({ ...item, read: true })))}
              >
                <CheckCheck size={13} />
                Mark all read
              </button>
            </header>
            <div className="notification-list">
              {items.length ? (
                groupByDay(items.slice(0, visibleLimit)).map((group) => (
                  <section key={group.label} className="notification-group">
                    <small className="notification-group-label">{group.label}</small>
                    {group.items.map((item) => (
                      <button
                        key={item.id}
                        className={`notification-item ${item.read ? 'read' : 'unread'}`}
                        aria-label={`${item.read ? '' : 'Unread: '}${item.title}`}
                        onClick={() =>
                          setItems((current) =>
                            current.map((entry) =>
                              entry.id === item.id ? { ...entry, read: true } : entry,
                            ),
                          )
                        }
                      >
                        <span className={`notification-icon ${item.success ? 'success' : 'failure'}`}>
                          {item.success ? <Check size={14} /> : <AlertCircle size={14} />}
                        </span>
                        <span className="notification-copy">
                          <span className="notification-line">
                            <strong>{item.title}</strong>
                            <time
                              dateTime={new Date(item.timestamp).toISOString()}
                              title={new Date(item.timestamp).toLocaleString()}
                            >
                              <small>{relativeTime(item.timestamp)}</small>
                            </time>
                          </span>
                          <small className="notification-detail">{item.detail}</small>
                        </span>
                      </button>
                    ))}
                  </section>
                ))
              ) : (
                <div className="notification-empty">
                  <span className="notification-empty-icon">
                    <Bell size={18} />
                  </span>
                  <strong>No finished tasks yet</strong>
                  <small>Terminal and agent tasks show up here when they finish.</small>
                </div>
              )}
            </div>
            {items.length > 0 && (
              <footer className="notification-footer">
                <small>
                  {items.length > visibleLimit
                    ? `Latest ${visibleLimit} of ${items.length}`
                    : `${items.length} ${items.length === 1 ? 'task' : 'tasks'}`}
                </small>
                <button className="notification-clear" onClick={() => setItems([])}>
                  <Trash2 size={12} />
                  Clear all
                </button>
              </footer>
            )}
          </AnchoredPopover>
        )}
      </AnimatePresence>
    </div>
  );
}
