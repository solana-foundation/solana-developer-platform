"use client";

import type { NotificationDto } from "@sdp/types";
import {
  BadgeCheck,
  Banknote,
  Bell,
  CheckCheck,
  Loader2,
  type LucideIcon,
  ShieldCheck,
  Users,
  Zap,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatRelativeTime } from "@/app/dashboard/activity-format-utils";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useInboxStream } from "./use-inbox-stream";

// The API's wire shape (raw snake_case rows) — shared with sdp-api via @sdp/types.
type NotificationItem = NotificationDto;

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

// Icon tile per notification type (falls back to the bell for unknown types).
const TYPE_ICON: Record<string, LucideIcon> = {
  workflow_execution: Zap,
  workflow_run_failed: Zap,
  workflow_approval_requested: ShieldCheck,
  workflow_approval_decided: ShieldCheck,
  member_invited: Users,
  member_joined: Users,
  member_invite_revoked: Users,
  member_removed: Users,
  payment_settled: Banknote,
  recurring_payment_failed: Banknote,
  kyc_approved: BadgeCheck,
  kyc_rejected: BadgeCheck,
};

// Humanize any snake_case system key left in server-composed text (e.g. an older row
// that stored `token_operation_completed`): "token_operation_completed" → "Token
// operation completed". A display-time safety net so no raw event key ever reaches a
// reader, regardless of when/where the row was written. The lookarounds skip tokens
// touching '@' or '.', so email addresses survive — member_invited bodies ARE an
// address, and "john_doe@acme.com" must not become "John doe@acme.com".
function humanizeKeys(text: string): string {
  return text.replace(/(?<![\w@.])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w@.])/g, (key) => {
    const spaced = key.replace(/_/g, " ");
    return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`.replace(/\bkyc\b/gi, "KYC");
  });
}

// Deep-link a notification to its subject. Keep this map in lockstep with the API's
// email-CTA map (apps/sdp-api/src/services/notifications/resource-links.ts). Unknown
// resource types render without a link.
function hrefFor(item: NotificationItem): string | null {
  switch (item.resource_type) {
    case "token": {
      if (!item.resource_id) return null;
      const base = `/dashboard/issuance/${item.resource_id}`;
      return item.type.startsWith("workflow_") ? `${base}?tab=workflows` : base;
    }
    case "member":
    case "invitation":
      return "/dashboard/members";
    case "payment_transfer":
      return "/dashboard/payments";
    case "recurring_payment":
      return "/dashboard/payments/recurring";
    case "counterparty":
      return "/dashboard/payments/counterparty";
    default:
      return null;
  }
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
  // Deepest page currently loaded — the next "Show more" fetches pageRef + 1. Derived
  // page math (items.length / PAGE_SIZE) broke as soon as merges deduped a row.
  const pageRef = useRef(1);
  // Ordering guard for nudges: two concurrent dispatches can publish counts read
  // around each other's inserts, so a later frame may carry the older count.
  const lastNudgeTs = useRef("");
  // Right after a local optimistic mutation, an in-flight nudge's count predates the
  // mark-read and would resurrect the badge; refreshCount reconciles instead.
  const suppressNudgeUntil = useRef(0);

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

  // Server-composed title unless the row's type has a localized template — then render
  // that so French users don't read English. workflow_execution keeps its trigger-label
  // interpolation (and honors rule-authored custom titles); every other known type maps
  // straight to Shared.notifications.types.<type>, with the server title as fallback.
  const displayTitle = (item: NotificationItem): string => {
    const params = item.params ?? {};
    if (item.type === "workflow_execution") {
      if (params.customTitle) {
        return item.title;
      }
      const triggerType = typeof params.triggerType === "string" ? params.triggerType : null;
      if (triggerType) {
        const trigger = safeT(
          `Shared.notifications.triggerLabels.${triggerType}`,
          undefined,
          triggerType.replaceAll("_", " ")
        );
        return safeT("Shared.notifications.types.workflow_execution", { trigger }, item.title);
      }
      return item.title;
    }
    if (item.type === "workflow_approval_decided") {
      // The generic key says "decided", flattening the one fact the reader cares
      // about; the producer records it in params.decision — use the variant keys.
      const decision = params.decision;
      if (decision === "approved" || decision === "rejected") {
        return safeT(
          `Shared.notifications.types.workflow_approval_decided_${decision}`,
          undefined,
          item.title
        );
      }
    }
    return safeT(`Shared.notifications.types.${item.type}`, undefined, item.title);
  };

  const refreshCount = useCallback(async () => {
    const data = await getJson<{ unread: number }>("/api/dashboard/notifications/unread-count");
    if (data) {
      setUnread(data.unread);
    }
  }, []);

  // merge=true (nudge refresh of an open panel): fold page 1 into the loaded list —
  // prepend unseen rows, refresh overlapping ones in place — instead of resetting a
  // user who has paged deeper back to 15 rows and yanking their scroll position.
  const loadList = useCallback(async (page: number, merge = false) => {
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
    setItems((prev) => {
      if (page === 1 && !merge) {
        return data.notifications;
      }
      // Dedupe by id in both directions: rows inserted after page 1 shift offsets, so
      // an appended page can overlap the loaded tail (the old derived-page math turned
      // that into duplicate React keys).
      const incoming = data.notifications;
      if (page === 1) {
        const byId = new Map(incoming.map((n) => [n.id, n]));
        const known = new Set(prev.map((n) => n.id));
        const refreshed = prev.map((n) => byId.get(n.id) ?? n);
        return [...incoming.filter((n) => !known.has(n.id)), ...refreshed];
      }
      const known = new Set(prev.map((n) => n.id));
      return [...prev, ...incoming.filter((n) => !known.has(n.id))];
    });
    if (!merge) {
      pageRef.current = page;
    }
    setTotal(data.total);
    setLoading(false);
  }, []);

  const loadConfig = useCallback(async () => {
    const data = await getJson<{ emailEnabled: boolean }>("/api/dashboard/notifications/config");
    setEmailEnabled(data ? data.emailEnabled : null);
  }, []);

  // Realtime nudges over SSE: the badge updates instantly from the pushed count, and
  // an open panel folds in fresh rows. Purely additive — the polling below stays as
  // the fallback whenever the stream is down.
  const openRef = useRef(open);
  openRef.current = open;
  const nudgeRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useInboxStream(
    useCallback(
      (nudge) => {
        // Ordering guard: drop frames older than the last applied one.
        if (nudge.ts && nudge.ts < lastNudgeTs.current) {
          return;
        }
        if (nudge.ts) {
          lastNudgeTs.current = nudge.ts;
        }
        // The badge write yields to a fresh local mutation (its count predates it);
        // the list refresh below is unaffected — rows carry their own read state.
        if (Date.now() >= suppressNudgeUntil.current) {
          setUnread(nudge.unread);
        }
        if (openRef.current) {
          // Trailing debounce: a burst of dispatches (batch settlement, failing cron
          // tick) must coalesce into one refetch, not one per nudge.
          if (nudgeRefreshTimer.current) {
            clearTimeout(nudgeRefreshTimer.current);
          }
          nudgeRefreshTimer.current = setTimeout(() => {
            nudgeRefreshTimer.current = null;
            if (openRef.current) {
              void loadList(1, true);
            }
          }, 750);
        }
      },
      [loadList]
    )
  );
  useEffect(() => {
    return () => {
      if (nudgeRefreshTimer.current) {
        clearTimeout(nudgeRefreshTimer.current);
      }
    };
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

  // Bounded POST — a wedged API must fail the mutation into rollback, not hang it.
  const postWithTimeout = async (url: string) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { method: "POST", signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  const markRead = async (id: string) => {
    suppressNudgeUntil.current = Date.now() + 2_000;
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n))
    );
    setUnread((prev) => Math.max(0, prev - 1));
    try {
      await postWithTimeout(`/api/dashboard/notifications/${encodeURIComponent(id)}/read`);
      // Server truth for the badge (the optimistic decrement can drift when more than
      // one page of unread rows exists).
      void refreshCount();
    } catch {
      // Revert ONLY this row, functionally — a wholesale restore of a captured array
      // would clobber whatever the stream merged in while the POST was in flight.
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: null } : n)));
      void refreshCount();
    }
  };

  const markAllRead = async () => {
    suppressNudgeUntil.current = Date.now() + 2_000;
    // One shared timestamp doubles as the marker for which rows THIS action touched,
    // so the failure path can revert exactly those and nothing else.
    const stampedAt = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: stampedAt })));
    setUnread(0);
    try {
      await postWithTimeout("/api/dashboard/notifications/read-all");
      void refreshCount();
    } catch {
      setItems((prev) => prev.map((n) => (n.read_at === stampedAt ? { ...n, read_at: null } : n)));
      void refreshCount();
    }
  };

  const onItemClick = (item: NotificationItem) => {
    // Navigation never waits on the mark-read POST: it's best-effort bookkeeping with
    // its own timeout/rollback, and gating the click on it made a slow API feel like
    // a dead button.
    if (!item.read_at) {
      void markRead(item.id);
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
            {unread > 0 ? (
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
            onItemClick={onItemClick}
            onRetryInitial={() => void loadList(1)}
            onShowMore={() => void loadList(pageRef.current + 1)}
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
  onRetryInitial: () => void;
  onShowMore: () => void;
}) {
  const {
    items,
    total,
    loading,
    loadError,
    locale,
    t,
    displayTitle,
    onItemClick,
    onRetryInitial,
    onShowMore,
  } = props;

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
          onClick={onRetryInitial}
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
      {loadError ? (
        // A failed "Show more" was previously silent (the empty-state branch above
        // only renders with no items): say so inline, where the click happened.
        <div className="flex items-center justify-center gap-2 border-t border-border-subtle px-4 py-2.5 text-xs text-secondary">
          {t("Shared.notifications.error")}
          <button
            type="button"
            onClick={onShowMore}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {t("Shared.notifications.retry")}
          </button>
        </div>
      ) : items.length < total ? (
        <button
          type="button"
          disabled={loading}
          onClick={onShowMore}
          className="flex w-full items-center justify-center gap-2 border-t border-border-subtle px-4 py-2.5 text-xs font-medium text-secondary transition-colors hover:bg-fill-subtle hover:text-primary disabled:opacity-60"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {t("Shared.notifications.showMoreCount", { loaded: items.length, total })}
        </button>
      ) : null}
    </div>
  );
}
