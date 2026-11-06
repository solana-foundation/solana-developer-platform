"use client";

import { formatTimestamp } from "@/app/(session)/dashboard/[projectId]/payments/payments-overview.utils";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useTimeZone } from "@/i18n/time-zone";

/**
 * A link's expiry in the payer's zone. A payer's first visit carries no `sdp-time-zone` cookie,
 * so the server renders UTC and the browser's zone takes over right after hydration. Keyed by
 * zone, the corrected time is a new element rather than the server's text sliding along the row,
 * so the swap is no layout shift.
 *
 * @param props.expiresAt - ISO timestamp the link stops working at.
 * @param props.className - The detail row value's classes.
 */
export function PayExpiry({ expiresAt, className }: { expiresAt: string; className: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const timeZone = useTimeZone();
  return (
    <span key={timeZone} className={className}>
      {formatTimestamp(expiresAt, t, locale, timeZone)}
    </span>
  );
}
