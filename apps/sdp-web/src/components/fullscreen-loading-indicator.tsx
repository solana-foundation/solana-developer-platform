"use client";

import { useEffect, useState } from "react";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { useTranslations } from "@/i18n/provider";

const DEFAULT_RELOAD_DELAY_MS = 15_000;

const SIDEBAR_ROW_IDS = [
  "shell-skeleton-nav-1",
  "shell-skeleton-nav-2",
  "shell-skeleton-nav-3",
  "shell-skeleton-nav-4",
  "shell-skeleton-nav-5",
];

const CONTENT_CARD_IDS = ["shell-skeleton-card-1", "shell-skeleton-card-2"];

/**
 * Stand-in for the whole dashboard while the client auth session resolves.
 *
 * It draws the shell's silhouette rather than a centred spinner. The route
 * skeletons Next.js streams are discarded when this renders, so a bare spinner
 * replaced a laid-out page with an empty screen for the best part of a second and
 * read as a hang. Same markup cost, same control flow — only what gets painted
 * changed, so the navigation loading contract is untouched.
 *
 * The status text stays in the accessibility tree; sighted users get the shape.
 */
export function FullscreenLoadingIndicator({
  allowDelayedReload = false,
  reloadDelayMs = DEFAULT_RELOAD_DELAY_MS,
}: {
  allowDelayedReload?: boolean;
  reloadDelayMs?: number;
}) {
  const t = useTranslations();
  const [showReload, setShowReload] = useState(false);

  useEffect(() => {
    if (!allowDelayedReload) return;
    const timeout = window.setTimeout(() => setShowReload(true), reloadDelayMs);
    return () => window.clearTimeout(timeout);
  }, [allowDelayedReload, reloadDelayMs]);

  return (
    <main
      aria-busy="true"
      data-shell-loading-skeleton
      className="flex min-h-screen bg-[var(--sdp-shell-bg)] text-primary"
    >
      <p role="status" aria-live="polite" className="sr-only">
        {t("Shared.dashboardShell.loadingDashboard")}
      </p>

      {/* Sidebar silhouette. Hidden below xl to match the real shell, which has no
          persistent sidebar on small screens. */}
      <div
        aria-hidden="true"
        className="hidden w-72 shrink-0 flex-col gap-8 border-r border-border-default px-4 py-5 xl:flex"
      >
        <div className="flex items-center gap-3">
          <SkeletonBlock className="size-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <SkeletonBlock className="h-3.5 w-24 rounded-[4px]" />
            <SkeletonBlock className="h-3 w-32 rounded-[4px]" />
          </div>
        </div>
        <div className="space-y-2">
          {SIDEBAR_ROW_IDS.map((id) => (
            <SkeletonBlock key={id} className="h-9 w-full rounded-[10px]" />
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div
          aria-hidden="true"
          className="flex h-16 shrink-0 items-center justify-between border-b border-border-default px-6"
        >
          <SkeletonBlock className="h-7 w-40 max-w-[45%] rounded-[6px]" />
          <div className="flex items-center gap-3">
            <SkeletonBlock className="size-8 rounded-full" />
            <SkeletonBlock className="h-7 w-20 rounded-full" />
          </div>
        </div>

        <div aria-hidden="true" className="mx-auto w-full max-w-7xl space-y-6 px-6 py-8">
          <div className="grid gap-4 sm:grid-cols-2">
            {CONTENT_CARD_IDS.map((id) => (
              <SkeletonBlock key={id} className="h-28 w-full rounded-[18px]" />
            ))}
          </div>
          <SkeletonBlock className="h-64 w-full rounded-[18px]" />
        </div>

        {showReload ? (
          <div className="flex justify-center pb-10">
            <button
              type="button"
              className="text-sm text-secondary underline underline-offset-4 transition-colors hover:text-primary motion-reduce:transition-none"
              onClick={() => window.location.reload()}
            >
              {t("Shared.dashboardShell.reloadDashboard")}
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
