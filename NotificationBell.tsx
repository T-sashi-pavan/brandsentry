import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell, CheckCheck, CheckCircle2, XCircle, RefreshCw, Send, Trash2, X,
} from 'lucide-react';
import { apiClient } from '@/api/client';
import { toast } from 'sonner';
import type { Notification, NotificationType } from '@/types';
import { cn } from '@/lib/utils';

// ── helpers ────────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const TYPE_META: Record<NotificationType, { icon: React.ElementType; color: string; bg: string }> = {
  legal_submitted:      { icon: Send,         color: 'text-blue-600',   bg: 'bg-blue-100'   },
  legal_approved:       { icon: CheckCircle2, color: 'text-green-600',  bg: 'bg-green-100'  },
  legal_rejected:       { icon: XCircle,      color: 'text-red-600',    bg: 'bg-red-100'    },
  legal_needs_revision: { icon: RefreshCw,    color: 'text-orange-600', bg: 'bg-orange-100' },
  legal_retracted:      { icon: Trash2,       color: 'text-gray-500',   bg: 'bg-gray-100'   },
};

// ── component ──────────────────────────────────────────────────────────────────

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const router = useRouter();

  // Poll unread count and notifications in background every 30 seconds
  const { data: countData } = useQuery({
    queryKey: ['notifications-count'],
    queryFn: () => apiClient.getUnreadCount(),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  // Fetch full notification list
  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => apiClient.getNotifications(),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => apiClient.markNotificationRead(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-count'] });
    },
  });

  const markAll = useMutation({
    mutationFn: () => apiClient.markAllNotificationsRead(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-count'] });
      toast.success('Marked all notifications as read');
    },
  });

  const clearAll = useMutation({
    mutationFn: () => apiClient.clearAllNotifications(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-count'] });
      qc.setQueryData(['notifications'], []);
      qc.setQueryData(['notifications-count'], { count: 0 });
      toast.success('All notifications cleared');
    },
  });

  const deleteOne = useMutation({
    mutationFn: (id: string) => apiClient.deleteNotification(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-count'] });
    },
  });

  // Close on outside click
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const unreadFromList = notifications.filter((n) => !n.is_read).length;
  const unread = Math.max(unreadFromList, countData?.count ?? 0);
  const hasUnread = unread > 0 || unreadFromList > 0 || notifications.some((n) => !n.is_read);

  function handleClick(n: Notification) {
    if (!n.is_read) markRead.mutate(n.id);
    setOpen(false);
    // All notification types are legal-review lifecycle events, and both
    // submitters and reviewers work out of the same shared queue page.
    router.push('/trademark-review');
  }

  return (
    <div className="relative" ref={ref}>
      {/* Bell button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="relative h-9 w-9 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors"
      >
        <Bell className="w-4 h-4 text-gray-600" />
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 bg-orange-600 rounded-full text-[9px] font-bold text-white flex items-center justify-center px-1 leading-none animate-in fade-in zoom-in-75 duration-200">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {/* Dropdown — fixed to the viewport's top-right corner */}
      {open && (
        <div className="fixed top-14 right-4 sm:right-6 w-96 max-w-[calc(100vw-2rem)] bg-white rounded-2xl shadow-xl border border-gray-100 z-50 flex flex-col max-h-[480px]">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-gray-700" />
              <span className="font-semibold text-gray-900 text-sm">Notifications</span>
              {hasUnread && (
                <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full font-semibold">
                  {unread} new
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="p-1 rounded-md hover:bg-gray-100 text-gray-400 hover:text-gray-600 cursor-pointer"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* List */}
          <div className="overflow-y-auto flex-1">
            {notifications.length === 0 ? (
              <div className="py-12 text-center">
                <Bell className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                <p className="text-sm text-gray-400">No notifications yet</p>
              </div>
            ) : (
              notifications.map(n => {
                const meta = TYPE_META[n.type] ?? TYPE_META.legal_submitted;
                const Icon = meta.icon;
                return (
                  <div
                    key={n.id}
                    className={cn(
                      'group w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors border-b border-gray-50 last:border-0 relative',
                      !n.is_read && 'bg-orange-50/50'
                    )}
                  >
                    <button
                      onClick={() => handleClick(n)}
                      className="flex-1 flex items-start gap-3 text-left min-w-0"
                    >
                      <div className={cn('w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5', meta.bg)}>
                        <Icon className={cn('w-4 h-4', meta.color)} />
                      </div>
                      <div className="flex-1 min-w-0 pr-4">
                        <div className="flex items-start justify-between gap-2">
                          <p className={cn('text-sm leading-snug', n.is_read ? 'text-gray-600 font-normal' : 'text-gray-900 font-semibold')}>
                            {n.title}
                          </p>
                          {!n.is_read && <span className="w-2 h-2 rounded-full bg-orange-500 flex-shrink-0 mt-1.5" />}
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{n.message}</p>
                        <p className="text-[10px] text-gray-300 mt-1">{timeAgo(n.created_at)}</p>
                      </div>
                    </button>

                    {/* Delete single notification button on hover */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteOne.mutate(n.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-200/80 text-gray-400 hover:text-red-600 transition-opacity absolute right-3 top-3"
                      title="Delete notification"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer */}
          {notifications.length > 0 && (
            <div className="p-2.5 border-t border-gray-100 flex items-center justify-between text-xs bg-gray-50/50 flex-shrink-0">
              <span className="text-gray-500 text-[11px] px-2 font-medium">
                {notifications.length} {notifications.length === 1 ? 'notification' : 'notifications'}
                {hasUnread && ` (${unread} unread)`}
              </span>
              <div className="flex items-center gap-2">
                {hasUnread && (
                  <button
                    type="button"
                    onClick={() => markAll.mutate()}
                    disabled={markAll.isPending}
                    className="text-xs text-orange-600 hover:text-orange-800 font-semibold px-2.5 py-1 rounded hover:bg-orange-100/50 transition-colors cursor-pointer flex items-center gap-1"
                  >
                    <CheckCheck className="w-3.5 h-3.5" />
                    Mark as read
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => clearAll.mutate()}
                  disabled={clearAll.isPending}
                  className="text-xs text-red-600 hover:text-red-800 font-semibold px-2.5 py-1 rounded hover:bg-red-100/50 transition-colors cursor-pointer flex items-center gap-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear All
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
