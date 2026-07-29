"use client";

import { Bell, CheckCheck, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  resource_type: string | null;
  resource_id: string | null;
  read_at: string | null;
  created_at: string;
}

const POLL_INTERVAL_MS = 60_000;

async function getJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { data?: T };
    return payload.data ?? null;
  } catch {
    return null;
  }
}

// Deep-link a notification to its subject (today: a token's asset profile).
function hrefFor(item: NotificationItem): string | null {
  if (item.resource_type === "token" && item.resource_id) {
    return `/dashboard/issuance/${item.resource_id}`;
  }
  return null;
}

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const refreshCount = useCallback(async () => {
    const data = await getJson<{ unread: number }>("/api/dashboard/notifications/unread-count");
    if (data) {
      setUnread(data.unread);
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    const data = await getJson<{ notifications: NotificationItem[] }>(
      "/api/dashboard/notifications?pageSize=15"
    );
    setItems(data?.notifications ?? []);
    setLoading(false);
  }, []);

  // Poll the unread count so the badge stays live without a socket.
  useEffect(() => {
    void refreshCount();
    const timer = setInterval(() => void refreshCount(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshCount]);

  // Load the list when the panel opens.
  useEffect(() => {
    if (open) {
      void loadList();
    }
  }, [open, loadList]);

  // Close on outside click.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const markRead = async (id: string) => {
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
    );
    setUnread((prev) => Math.max(0, prev - 1));
    await fetch(`/api/dashboard/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
  };

  const markAllRead = async () => {
    setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
    setUnread(0);
    await fetch("/api/dashboard/notifications/read-all", { method: "POST" });
  };

  const onItemClick = async (item: NotificationItem) => {
    if (!item.read_at) {
      await markRead(item.id);
    }
    const href = hrefFor(item);
    if (href) {
      setOpen(false);
      router.push(href);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Notifications"
        aria-haspopup="true"
        aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded-full text-secondary transition-colors hover:bg-fill-subtle hover:text-primary"
      >
        <Bell className="h-4.5 w-4.5" />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-error px-1 text-[10px] font-semibold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-border-default bg-surface-raised shadow-lg">
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
            <span className="text-sm font-semibold text-primary">Notifications</span>
            {items.some((n) => !n.read_at) ? (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="inline-flex items-center gap-1 text-xs text-secondary transition-colors hover:text-primary"
              >
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </button>
            ) : null}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 px-4 py-8 text-sm text-secondary">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-secondary">You're all caught up.</p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => void onItemClick(item)}
                      className="flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-fill-subtle"
                    >
                      <span
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                          item.read_at ? "bg-transparent" : "bg-info"
                        }`}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-primary">
                          {item.title}
                        </span>
                        {item.body ? (
                          <span className="mt-0.5 block text-xs text-secondary">{item.body}</span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
