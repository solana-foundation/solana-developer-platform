"use client";

import { Bell, CheckCheck, Loader2, type LucideIcon, Zap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatRelativeTime } from "@/app/dashboard/activity-format-utils";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  resource_type: string | null;
  resource_id: string | null;
  params: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

const POLL_INTERVAL_MS = 60_000;
const PAGE_SIZE = 15;
const REQUEST_TIMEOUT_MS = 10_000;

async function getJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  // Abort a stalled request so a hung API (e.g. a wedged DB connection) degrades to the
  // panel's error + retry state instead of an endless spinner.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", ...init, signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { data?: T };
    return payload.data ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Icon tile per notification type (workflow automations today; falls back to the bell).
const TYPE_ICON: Record<string, LucideIcon> = {
  workflow_execution: Zap,
};

// Humanize any snake_case system key left in server-composed text (e.g. an older row
// that stored `token_operation_completed`): "token_operation_completed" → "Token
// operation completed". A display-time safety net so no raw event key ever reaches a
// reader, regardless of when/where the row was written.
function humanizeKeys(text: string): string {
  return text.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (key) => {
    const spaced = key.replace(/_/g, " ");
    return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`.replace(/\bkyc\b/gi, "KYC");
  });
}

// Deep-link a notification to its subject (today: a token's asset profile; workflow
// notifications land directly on the Workflows tab).
function hrefFor(item: NotificationItem): string | null {
  if (item.resource_type === "token" && item.resource_id) {
    const base = `/dashboard/issuance/${item.resource_id}`;
    return item.type === "workflow_execution" ? `${base}?tab=workflows` : base;
  }
  return null;
}

export function NotificationBell() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // null = unknown (config unreachable) — only an explicit `false` shows the warning.
  const [emailEnabled, setEmailEnabled] = useState<boolean | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Drops out-of-order responses (rapid open/close, slow network).
  const listGeneration = useRef(0);

  // Translate with a safe fallback — a missing key must degrade, not crash the shell.
  const safeT = useCallback(
    (key: string, values: Record<string, string | number> | undefined, fallback: string) => {
      try {
        return t(key as MessageKey, values);
      } catch {
        return fallback;
      }
    },
    [t]
  );

  // Server-composed title unless the row carries structured params without a custom
  // title — then render a localized template so French users don't read English.
  const displayTitle = (item: NotificationItem): string => {
    const params = item.params ?? {};
    if (item.type === "workflow_execution" && !params.customTitle) {
      const triggerType = typeof params.triggerType === "string" ? params.triggerType : null;
      if (triggerType) {
        const trigger = safeT(
          `Shared.notifications.triggerLabels.${triggerType}`,
          undefined,
          triggerType.replaceAll("_", " ")
        );
        return safeT("Shared.notifications.types.workflow_execution", { trigger }, item.title);
      }
    }
    return item.title;
  };

  const refreshCount = useCallback(async () => {
    const data = await getJson<{ unread: number }>("/api/dashboard/notifications/unread-count");
    if (data) {
      setUnread(data.unread);
    }
  }, []);

  const loadList = useCallback(async (page: number) => {
    const generation = ++listGeneration.current;
    setLoading(true);
    setLoadError(false);
    const data = await getJson<{ notifications: NotificationItem[]; total: number }>(
      `/api/dashboard/notifications?page=${page}&pageSize=${PAGE_SIZE}`
    );
    if (generation !== listGeneration.current) {
      return;
    }
    if (!data) {
      setLoadError(true);
      setLoading(false);
      return;
    }
    setItems((prev) => (page === 1 ? data.notifications : [...prev, ...data.notifications]));
    setTotal(data.total);
    setLoading(false);
  }, []);

  const loadConfig = useCallback(async () => {
    const data = await getJson<{ emailEnabled: boolean }>("/api/dashboard/notifications/config");
    setEmailEnabled(data ? data.emailEnabled : null);
  }, []);

  // Poll the unread count so the badge stays live without a socket. Hidden tabs skip
  // the tick; returning to the tab refreshes immediately.
  useEffect(() => {
    void refreshCount();
    const timer = setInterval(() => {
      if (!document.hidden) {
        void refreshCount();
      }
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) {
        void refreshCount();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refreshCount]);

  // Load the list (first page) + email availability when the panel opens.
  useEffect(() => {
    if (open) {
      void loadList(1);
      void loadConfig();
    }
  }, [open, loadList, loadConfig]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Close on outside click and on Escape.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const markRead = async (id: string) => {
    const previousItems = items;
    const previousUnread = unread;
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n))
    );
    setUnread((prev) => Math.max(0, prev - 1));
    try {
      const response = await fetch(`/api/dashboard/notifications/${encodeURIComponent(id)}/read`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      // Server truth for the badge (the optimistic decrement can drift when more than
      // one page of unread rows exists).
      void refreshCount();
    } catch {
      setItems(previousItems);
      setUnread(previousUnread);
    }
  };

  const markAllRead = async () => {
    const previousItems = items;
    const previousUnread = unread;
    setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
    setUnread(0);
    try {
      const response = await fetch("/api/dashboard/notifications/read-all", { method: "POST" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      void refreshCount();
    } catch {
      setItems(previousItems);
      setUnread(previousUnread);
    }
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

  const ariaLabel =
    unread > 0
      ? safeT("Shared.notifications.ariaLabelUnread", { count: unread }, "Notifications")
      : t("Shared.notifications.ariaLabel");

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded-full text-secondary transition-colors hover:bg-fill-subtle hover:text-primary"
      >
        <Bell className="h-4.5 w-4.5" />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-info px-1 text-[10px] font-semibold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-labelledby={titleId}
          className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-border-default bg-surface-raised shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
            <span id={titleId} className="text-sm font-semibold text-primary">
              {t("Shared.notifications.title")}
            </span>
            {items.some((n) => !n.read_at) ? (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="inline-flex items-center gap-1 text-xs text-secondary transition-colors hover:text-primary"
              >
                <CheckCheck className="h-3.5 w-3.5" /> {t("Shared.notifications.markAllRead")}
              </button>
            ) : null}
          </div>

          {emailEnabled === false ? (
            <p className="border-b border-border-subtle bg-fill-subtle px-4 py-2 text-xs text-secondary">
              {t("Shared.notifications.emailUnavailable")}
            </p>
          ) : null}

          <NotificationPanelBody
            items={items}
            total={total}
            loading={loading}
            loadError={loadError}
            locale={locale}
            t={t}
            displayTitle={displayTitle}
            onItemClick={(item) => void onItemClick(item)}
            onLoadPage={(page) => void loadList(page)}
          />
        </div>
      ) : null}
    </div>
  );
}

function NotificationPanelBody(props: {
  items: NotificationItem[];
  total: number;
  loading: boolean;
  loadError: boolean;
  locale: string;
  t: ReturnType<typeof useTranslations>;
  displayTitle: (item: NotificationItem) => string;
  onItemClick: (item: NotificationItem) => void;
  onLoadPage: (page: number) => void;
}) {
  const { items, total, loading, loadError, locale, t, displayTitle, onItemClick, onLoadPage } =
    props;

  if (loading && items.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-8 text-sm text-secondary">
        <Loader2 className="h-4 w-4 animate-spin" /> {t("Shared.notifications.loading")}
      </div>
    );
  }
  if (loadError && items.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-sm text-secondary">{t("Shared.notifications.error")}</p>
        <button
          type="button"
          onClick={() => onLoadPage(1)}
          className="mt-2 text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          {t("Shared.notifications.retry")}
        </button>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-secondary">
        {t("Shared.notifications.empty")}
      </p>
    );
  }
  return (
    <div className="max-h-96 overflow-y-auto">
      <ul className="divide-y divide-border-subtle">
        {items.map((item) => {
          const TypeIcon = TYPE_ICON[item.type] ?? Bell;
          const unread = !item.read_at;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onItemClick(item)}
                className="flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-fill-subtle"
              >
                <span
                  className="relative flex size-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-secondary"
                  aria-hidden
                >
                  <TypeIcon className="size-[18px]" />
                  {unread ? (
                    <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-info ring-2 ring-surface-raised" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block truncate text-sm ${unread ? "font-semibold text-primary" : "font-medium text-secondary"}`}
                  >
                    {humanizeKeys(displayTitle(item))}
                  </span>
                  {item.body ? (
                    <span className="mt-0.5 block text-xs text-secondary">
                      {humanizeKeys(item.body)}
                    </span>
                  ) : null}
                  <span className="mt-0.5 block text-xs text-tertiary">
                    {formatRelativeTime(item.created_at, locale)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {items.length < total ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => onLoadPage(Math.floor(items.length / PAGE_SIZE) + 1)}
          className="flex w-full items-center justify-center gap-2 border-t border-border-subtle px-4 py-2.5 text-xs font-medium text-secondary transition-colors hover:bg-fill-subtle hover:text-primary disabled:opacity-60"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {t("Shared.notifications.showMore")}
        </button>
      ) : null}
    </div>
  );
}
