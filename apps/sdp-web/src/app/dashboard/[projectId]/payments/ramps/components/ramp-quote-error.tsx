"use client";

import { XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

/**
 * Terminal state for a failed automatic quote creation on the transaction
 * stage, with an explicit retry.
 *
 * @param props.error - The quote creation failure.
 * @param props.retrying - Whether a retry attempt is in flight.
 * @param props.onRetry - Re-runs quote creation.
 * @returns The quote creation error panel.
 */
export function RampQuoteError({
  error,
  retrying,
  onRetry,
}: {
  error: Error;
  retrying: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <XCircleIcon className="size-10 text-error" />
      <p className="text-lg font-medium text-primary">
        {t("DashboardPayments.ramps.unableToCreateQuote")}
      </p>
      <p className="max-w-md text-sm leading-relaxed text-tertiary">{error.message}</p>
      <Button type="button" variant="secondary" disabled={retrying} onClick={onRetry}>
        {t("DashboardPayments.ramps.tryAgain")}
      </Button>
    </div>
  );
}
