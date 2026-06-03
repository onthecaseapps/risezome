'use client';

import { useState, useTransition, type ReactElement } from 'react';
import type { NotificationView } from './_types';
import { CloseGlyph } from './_bits';
import { markNotificationReadAction } from './notification-actions';

/**
 * Fresh-assignment toasts (plan U12 / mockup #9). Renders unread gap_assigned
 * notifications as dismissible cards, top-right. "View gap" opens the drawer
 * (and marks the notification read); "Dismiss" just marks it read.
 */
export function GapToasts({
  notifications,
  onView,
}: {
  notifications: NotificationView[];
  onView: (gapId: string) => void;
}): ReactElement | null {
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const visible = notifications.filter((n) => !hidden.has(n.notificationId));
  if (visible.length === 0) return null;

  function hide(id: number): void {
    setHidden((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  return (
    <div className="fixed right-5 top-5 z-50 flex w-80 flex-col gap-3">
      {visible.slice(0, 3).map((n) => (
        <ToastCard key={n.notificationId} notification={n} onHide={() => hide(n.notificationId)} onView={onView} />
      ))}
    </div>
  );
}

function ToastCard({
  notification: n,
  onHide,
  onView,
}: {
  notification: NotificationView;
  onHide: () => void;
  onView: (gapId: string) => void;
}): ReactElement {
  const [, start] = useTransition();

  function markRead(): void {
    start(async () => {
      await markNotificationReadAction(n.notificationId);
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-xl">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-fg">New gap assigned to you</p>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            markRead();
            onHide();
          }}
          className="flex h-6 w-6 items-center justify-center rounded text-muted hover:text-fg"
        >
          <CloseGlyph />
        </button>
      </div>
      <p className="mt-1 text-sm text-muted">
        {n.actorName !== null ? `${n.actorName} assigned ` : 'Assigned '}
        <span className="font-medium text-fg">“{n.gapTitle ?? 'a gap'}”</span> · asked {n.frequency}×.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            markRead();
            onHide();
            onView(n.gapId);
          }}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg transition-opacity hover:opacity-90"
        >
          View gap
        </button>
        <button
          type="button"
          onClick={() => {
            markRead();
            onHide();
          }}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-accent/40"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
