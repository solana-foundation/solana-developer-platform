"use client";

import { Button } from "@sdp/ui/button";
import { SkeletonBlock } from "@sdp/ui/skeleton-block";
import { useTranslations } from "@/i18n/provider";
import type { DashboardReadError } from "@/lib/dashboard-swr";

const SKELETON_ROW_IDS = ["first", "second", "third"] as const;

export function SettingsRowsSkeleton({ rows }: { rows: 1 | 2 | 3 }) {
  return (
    <div className="flex flex-col" aria-busy="true">
      {SKELETON_ROW_IDS.slice(0, rows).map((id) => (
        <div
          key={id}
          className="flex items-center justify-between gap-4 border-b border-border-subtle py-2.5 last:border-b-0"
        >
          <SkeletonBlock className="my-0.5 h-4 w-20" />
          <SkeletonBlock className="my-0.5 h-4 w-40 max-w-full" />
        </div>
      ))}
    </div>
  );
}

/** The API's message when it sent one, so a failed read says why. */
export function useReadFailureText() {
  const t = useTranslations();
  return (error: DashboardReadError) =>
    error.message === "" ? t("Shared.organizationSettings.unexpectedError") : error.message;
}

export function SettingsLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useTranslations();
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3">
      <p className="text-body text-error">{message}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {t("Shared.organizationSettings.retry")}
      </Button>
    </div>
  );
}
