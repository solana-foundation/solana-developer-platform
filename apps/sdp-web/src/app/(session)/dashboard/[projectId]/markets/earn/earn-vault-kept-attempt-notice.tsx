"use client";

import type { EarnVaultPosition } from "@sdp/types/earn";
import { Callout } from "@sdp/ui/callout";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatBpsPercent, formatDurationSeconds, formatTokenValue } from "./earn-format";

/** The queue terms an ADOPTED replay restores at confirm, disclosed on review. */
export type RestoredQueueTerms = { deadlineSeconds: number; discountBps: number };

/**
 * The review-step notice for a confirm that RESUBMITS A SAVED REQUEST — an
 * adopted kept attempt (see `recallAsyncWithdrawalKeptAttempt`)
 * or this build's own kept key (see `keptAsyncWithdrawalRetry`), shared by
 * both asynchronous exit modals because it discloses the same fact: the share
 * intent the confirm will send is generally NOT the derivation the rows above
 * show (it was derived from an earlier live position value), so the review
 * must say so before the submit, not after. When the saved share intent was
 * LOST (`undefined`) the attempt cannot be replayed exactly and nothing will
 * be sent — the notice says that instead of a confirm that could only fail or
 * double-escrow. An ADOPTED queue replay also restores its OWN discount and
 * deadline (the body is rebuilt from the kept fingerprint's identity — see
 * `asyncWithdrawalRecoveryBody`), so `restoredTerms` carries them and the
 * notice says so: the rows above show the live preview's terms, not the
 * replay's. The held-intermediate route shows no notice at all: its request
 * IS the typed input the rows already show.
 */
export function KeptAsyncAttemptNotice({
  restoredTerms,
  shareMint,
  shares,
}: {
  /** The recovered queue terms an ADOPTED replay restores, when the route has any. */
  restoredTerms?: RestoredQueueTerms | undefined;
  shareMint: EarnVaultPosition["shareMint"];
  shares: string | undefined;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const restored =
    shares !== undefined && restoredTerms
      ? t("DashboardEarn.vaultWithdraw.keptAsyncAttemptRestoredTerms", {
          discount: formatBpsPercent(restoredTerms.discountBps),
          duration:
            formatDurationSeconds(restoredTerms.deadlineSeconds, locale) ??
            t("DashboardEarn.unavailable"),
        })
      : null;
  return (
    <Callout className="mt-4" variant="warning">
      {shares === undefined
        ? t("DashboardEarn.vaultWithdraw.keptAttemptRequestLost")
        : t("DashboardEarn.vaultWithdraw.keptAsyncAttemptReviewNote", {
            shares: formatTokenValue(shares, shareMint, locale),
          })}
      {restored ? ` ${restored}` : null}
    </Callout>
  );
}
