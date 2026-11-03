"use client";

import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { InfoHint } from "@sdp/ui/info-hint";
import { useTranslations } from "@/i18n/provider";
import { countUnpricedHoldings, resolveTotalBalance } from "./payments-overview.utils";

/**
 * The info icon beside a total from `resolveTotalBalance` when holdings with no price feed sit
 * behind it: left out of the dollar total, or the reason there is none. Nothing when every
 * holding is priced. It goes on the figure's own line, so the figure keeps its height either way.
 */
export function UnpricedHoldingsHint({ balances }: { balances: CustodyWalletTokenBalance[] }) {
  const t = useTranslations();
  const unpricedCount = countUnpricedHoldings(balances);
  if (unpricedCount === 0) {
    return null;
  }

  if (resolveTotalBalance(balances) === null) {
    return <InfoHint text={t("Shared.holdings.noPriceFeed")} />;
  }

  return (
    <InfoHint
      text={
        unpricedCount === 1
          ? t("Shared.holdings.excludesUnpriced.one")
          : t("Shared.holdings.excludesUnpriced.other", { count: unpricedCount })
      }
    />
  );
}
