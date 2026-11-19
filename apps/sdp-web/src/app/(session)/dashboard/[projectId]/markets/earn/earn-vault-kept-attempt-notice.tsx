"use client";

import type { EarnVaultPosition } from "@sdp/types/earn";
import { Callout } from "@sdp/ui/callout";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatTokenValue } from "./earn-format";

/**
 * The review-step notice for a confirm that RESUBMITS A SAVED REQUEST — an
 * adopted previous-build attempt (see `recallLegacyAsyncWithdrawalKeptKey`)
 * or this build's own kept key (see `keptAsyncWithdrawalRetry`), shared by
 * both asynchronous exit modals because it discloses the same fact: the share
 * intent the confirm will send is generally NOT the derivation the rows above
 * show (it was derived from an earlier live position value), so the review
 * must say so before the submit, not after. When the saved share intent was
 * LOST (`undefined`) the attempt cannot be replayed exactly and nothing will
 * be sent — the notice says that instead of a confirm that could only fail or
 * double-escrow. The held-intermediate route shows no notice at all: its
 * request IS the typed input the rows already show.
 */
export function KeptAsyncAttemptNotice({
  shareMint,
  shares,
}: {
  shareMint: EarnVaultPosition["shareMint"];
  shares: string | undefined;
}) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <Callout className="mt-4" variant="warning">
      {shares === undefined
        ? t("DashboardEarn.vaultWithdraw.keptAttemptRequestLost")
        : t("DashboardEarn.vaultWithdraw.keptAsyncAttemptReviewNote", {
            shares: formatTokenValue(shares, shareMint, locale),
          })}
    </Callout>
  );
}
