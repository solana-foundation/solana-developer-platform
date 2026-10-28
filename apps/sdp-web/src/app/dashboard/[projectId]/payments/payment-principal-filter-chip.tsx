"use client";

import { Badge } from "@sdp/ui/badge";
import { Button } from "@sdp/ui/button";
import { useTranslations } from "@/i18n/provider";
import type { PaymentPrincipalFilter } from "@/lib/payment-principal-filter";

/**
 * The principal a payment list is narrowed to, as the revoke and member-removal dialogs link to
 * it, with a way back to everyone's.
 *
 * @param props - The filter and how to clear it.
 * @param props.filter - The principal the list shows.
 * @param props.pending - Whether a list navigation is in flight.
 * @param props.onClear - Clears the filter.
 * @returns The chip.
 */
export function PaymentPrincipalFilterChip({
  filter,
  pending,
  onClear,
}: {
  filter: PaymentPrincipalFilter;
  pending: boolean;
  onClear: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline">
        {filter.kind === "api_key"
          ? t("DashboardPayments.principalFilter.apiKey", { id: filter.apiKeyId })
          : t("DashboardPayments.principalFilter.member")}
      </Badge>
      <Button type="button" variant="link" size="sm" disabled={pending} onClick={onClear}>
        {t("DashboardPayments.principalFilter.clear")}
      </Button>
    </div>
  );
}
