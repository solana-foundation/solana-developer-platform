"use client";

import { type ReactNode, useEffect, useState } from "react";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";

const DEFAULT_RELOAD_DELAY_MS = 15_000;
const SIDEBAR_ROW_IDS = ["home", "wallets", "issuance", "payments", "api-keys"];

/** Shared dashboard frame while workspace, scope, or client auth resolves. */
export function FullscreenLoadingIndicator({
  allowDelayedReload = false,
  children,
  contentWidthClass = "max-w-7xl",
  hideTitle = false,
  isSidebarOpen = true,
  reloadDelayMs = DEFAULT_RELOAD_DELAY_MS,
  statusMessage,
  action,
  paused = false,
}: {
  allowDelayedReload?: boolean;
  children: ReactNode;
  contentWidthClass?: string;
  hideTitle?: boolean;
  isSidebarOpen?: boolean;
  reloadDelayMs?: number;
  statusMessage?: string;
  action?: ReactNode;
  paused?: boolean;
}) {
  const t = useTranslations();
  const [showReload, setShowReload] = useState(false);

  useEffect(() => {
    if (!allowDelayedReload) return;
    const timeout = window.setTimeout(() => setShowReload(true), reloadDelayMs);
    return () => window.clearTimeout(timeout);
  }, [allowDelayedReload, reloadDelayMs]);

  const recoveryAction =
    action ??
    (showReload ? (
      <button
        type="button"
        className="shrink-0 text-sm text-secondary underline underline-offset-4 hover:text-primary"
        onClick={() => window.location.reload()}
      >
        {t("Shared.dashboardShell.reloadDashboard")}
      </button>
    ) : null);

  return (
    <main
      aria-busy={!paused}
      data-shell-loading-skeleton
      className={cn(
        "flex min-h-screen bg-[var(--sdp-shell-bg)] text-primary",
        paused && "[&_*]:animate-none"
      )}
    >
      <div
        aria-hidden="true"
        style={{ width: isSidebarOpen ? 296 : 64 }}
        className="hidden shrink-0 flex-col gap-8 px-4 py-5 md:flex"
      >
        <div className="flex items-center gap-3">
          <SkeletonBlock className="size-8 shrink-0 rounded-lg" />
          {isSidebarOpen ? (
            <div className="min-w-0 flex-1 space-y-1.5">
              <SkeletonBlock className="h-3.5 w-24 rounded-[4px]" />
              <SkeletonBlock className="h-3 w-32 rounded-[4px]" />
            </div>
          ) : null}
        </div>
        <div className="space-y-2">
          {SIDEBAR_ROW_IDS.map((id) => (
            <SkeletonBlock key={id} className="h-10 w-full rounded-[10px]" />
          ))}
        </div>
        <SkeletonBlock className="mt-auto h-10 w-full rounded-[10px]" />
      </div>

      <section className="relative min-w-0 flex-1 rounded-2xl rounded-tr-none border border-border-subtle bg-surface-raised/80 px-3 py-5 md:p-6">
        <div aria-hidden="true" className="space-y-6">
          <div className="grid min-h-10 grid-cols-[1fr_auto] items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
            <SkeletonBlock className="size-8 rounded-lg md:invisible" />
            {hideTitle ? null : (
              <SkeletonBlock className="col-span-2 row-start-2 mx-auto h-10 w-40 rounded-[6px] sm:col-span-1 sm:col-start-2 sm:row-start-1" />
            )}
            <SkeletonBlock className="col-start-2 row-start-1 h-8 w-20 justify-self-end rounded-full sm:col-start-3" />
          </div>
          <div className={`mx-auto min-w-0 w-full ${contentWidthClass} pb-20 md:pb-0`}>
            {children}
          </div>
        </div>

        <div
          role="status"
          aria-live="polite"
          className={
            recoveryAction
              ? "sticky bottom-20 mx-auto flex max-w-xl items-center justify-between gap-4 rounded-xl border border-border-default bg-surface-raised p-4 shadow-sm md:bottom-6"
              : "sr-only"
          }
        >
          <p className="text-sm text-secondary">
            {statusMessage ?? t("Shared.dashboardShell.loadingDashboard")}
          </p>
          {recoveryAction}
        </div>
      </section>
    </main>
  );
}
