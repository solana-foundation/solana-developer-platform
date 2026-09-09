"use client";

import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/i18n/provider";
import type { DvpTradeStatus } from "./dvp-trade";

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

export function DvpStatusBadge({ status }: { status: DvpTradeStatus }) {
  const t = useTranslations();
  return (
    <Badge variant={STATUS_VARIANT[status]}>
      {t(`DashboardMarkets.dvp.status.${status}` as never)}
    </Badge>
  );
}
