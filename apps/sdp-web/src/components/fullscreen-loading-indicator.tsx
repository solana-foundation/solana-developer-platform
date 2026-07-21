"use client";

import { useTranslations } from "@/i18n/provider";

export function FullscreenLoadingIndicator() {
  const t = useTranslations();

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--sdp-shell-bg)] text-primary">
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-4">
        <span
          aria-hidden="true"
          className="size-7 animate-spin rounded-full border-2 border-border-strong border-t-primary"
        />
        <p className="text-sm text-tertiary">{t("Shared.dashboardShell.loadingDashboard")}</p>
      </div>
    </main>
  );
}
