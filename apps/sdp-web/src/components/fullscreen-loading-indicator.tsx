"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "@/i18n/provider";

const DEFAULT_RELOAD_DELAY_MS = 15_000;

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
    <main className="flex min-h-screen items-center justify-center bg-[var(--sdp-shell-bg)] text-primary">
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-4">
        <span
          aria-hidden="true"
          className="size-7 animate-spin rounded-full border-2 border-border-strong border-t-primary"
        />
        <p className="text-sm text-tertiary">{t("Shared.dashboardShell.loadingDashboard")}</p>
        {showReload ? (
          <button
            type="button"
            className="text-sm text-secondary underline underline-offset-4 transition-colors hover:text-primary"
            onClick={() => window.location.reload()}
          >
            {t("Shared.dashboardShell.reloadDashboard")}
          </button>
        ) : null}
      </div>
    </main>
  );
}
