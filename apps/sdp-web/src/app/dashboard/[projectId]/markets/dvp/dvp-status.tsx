"use client";

import type { DvpSettlementAvailability, DvpTradeStatus } from "@sdp/types/dvp";
import { Badge } from "@sdp/ui/badge";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";

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

/** The badge's copy, keyed exhaustively like `STATUS_VARIANT`: a status added
 * to `@sdp/types/dvp` is a compile error here rather than a raw message key at
 * runtime. */
const STATUS_MESSAGE_KEY: Record<DvpTradeStatus, MessageKey> = {
  creating: "DashboardMarkets.dvp.status.creating",
  create_failed: "DashboardMarkets.dvp.status.create_failed",
  created: "DashboardMarkets.dvp.status.created",
  partially_funded: "DashboardMarkets.dvp.status.partially_funded",
  funded: "DashboardMarkets.dvp.status.funded",
  settled: "DashboardMarkets.dvp.status.settled",
  cancelled: "DashboardMarkets.dvp.status.cancelled",
  rejected: "DashboardMarkets.dvp.status.rejected",
  expired: "DashboardMarkets.dvp.status.expired",
  closed_unknown: "DashboardMarkets.dvp.status.closed_unknown",
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
  return <Badge variant={STATUS_VARIANT[status]}>{t(STATUS_MESSAGE_KEY[status])}</Badge>;
}
