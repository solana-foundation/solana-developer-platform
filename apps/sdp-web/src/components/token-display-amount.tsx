"use client";

import {
  APPROXIMATE_TOKEN_DISPLAY_RULES,
  type TokenBalanceAmounts,
} from "@sdp/types/token-movements";
import { useLocale, useTranslations } from "@/i18n/provider";

/**
 * A holding's display amount, as a wallet shows it (ADR 0012). The caller
 * formats `displayAmount`; this adds "≈" and the chain time for an
 * interest-bearing mint. Never use it for an amount the user sends.
 *
 * The time is a caption, not a tooltip, so it stays readable inside a link row.
 */
export function TokenDisplayAmount({
  balance,
  formatted,
}: {
  balance: Pick<TokenBalanceAmounts, "displayRule" | "displayAsOf">;
  formatted: string;
}) {
  if (!APPROXIMATE_TOKEN_DISPLAY_RULES[balance.displayRule]) {
    return formatted;
  }
  return <ApproximateDisplayAmount displayAsOf={balance.displayAsOf} formatted={formatted} />;
}

/** Only an approximate amount needs copy, so an exact one renders without the catalog. */
function ApproximateDisplayAmount({
  displayAsOf,
  formatted,
}: {
  displayAsOf: string | null;
  formatted: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <>
      {t("Shared.tokenDisplay.approximate", { amount: formatted })}
      {displayAsOf === null ? null : (
        <span className="ml-1 text-xs text-tertiary">
          {t("Shared.tokenDisplay.asOf", {
            time: new Intl.DateTimeFormat(locale, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }).format(new Date(displayAsOf)),
          })}
        </span>
      )}
    </>
  );
}
