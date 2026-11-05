"use client";

import { Button } from "@sdp/ui/button";
import { useTranslations } from "@/i18n/provider";

/**
 * Inline "this section failed to load" notice, with a retry when the section can re-read.
 *
 * `message` is the API's own error text when there is one, so it stays untranslated; the
 * generic text is localised.
 */
export function PrivateChannelsLoadError({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error sm:flex-row sm:items-center sm:justify-between">
      <span>{message || t("DashboardPrivateChannels.common.loadError")}</span>
      {onRetry ? (
        <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
          {t("DashboardPrivateChannels.common.retry")}
        </Button>
      ) : null}
    </div>
  );
}
