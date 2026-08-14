"use client";

import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/i18n/provider";
import type { PolicyAssetOption } from "./wallet-policy-authoring";

/**
 * Identifies SDP-issued and custom assets while leaving well-known tokens unbadged.
 *
 * @param props - Asset mint and optional catalogue metadata.
 * @returns The matching asset-origin badge, or nothing for a well-known token.
 */
export function PolicyAssetBadge({
  mint,
  option,
}: {
  mint: string;
  option: PolicyAssetOption | undefined;
}) {
  const t = useTranslations();

  if (WELL_KNOWN_TOKEN_BY_MINT.has(mint)) return null;
  if (option?.sdpIssued) {
    return (
      <Badge variant="outline" className="shrink-0">
        {t("Shared.SharedComponents.sdpMintedToken")}
      </Badge>
    );
  }
  return <Badge className="shrink-0">{t("DashboardCustody.policyAssetBadgeCustom")}</Badge>;
}
