"use client";

import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/i18n/provider";
import type { DvpSettlementAvailability, DvpTradeStatus } from "./dvp-trade";

/**
 * Status tone.
 *
 * `closed_unknown` is deliberately neutral rather than a success: the trade
 * account is gone, and settle, cancel and reject all close it without
 * announcing which. Colouring it green would assert an outcome nothing has
 * established.
 */
const STATUS_VARIANT: Record<
  DvpTradeStatus,
  "default" | "success" | "warning" | "danger" | "info" | "outline"
> = {
  creating: "outline",
  create_failed: "danger",
  created: "info",
  partially_funded: "info",
  funded: "success",
  settled: "success",
  cancelled: "default",
  rejected: "danger",
  expired: "warning",
  closed_unknown: "default",
};

/**
 * The trade's status, with one refinement: `funded` reads "Ready to settle", which
 * is false while the earliest settlement time is still ahead, so that case says
 * "Funded" instead. Judged by the API's `settlementAvailability`, never a
 * browser clock.
 */
export function DvpStatusBadge({
  status,
  settlementAvailability,
}: {
  status: DvpTradeStatus;
  settlementAvailability: DvpSettlementAvailability | null;
}) {
  const t = useTranslations();
  if (status === "funded" && settlementAvailability === "too_early") {
    return <Badge variant="info">{t("DashboardMarkets.dvp.statusFundedTooEarly")}</Badge>;
  }
  return (
    <Badge variant={STATUS_VARIANT[status]}>
      {t(`DashboardMarkets.dvp.status.${status}` as never)}
    </Badge>
  );
}
