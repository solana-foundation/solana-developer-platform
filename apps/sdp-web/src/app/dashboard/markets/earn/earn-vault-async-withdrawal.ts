import type {
  EarnVaultQueuedWithdrawalTerms,
  EarnVaultWithdrawalOptions,
  EarnVaultWithdrawalRequestRecord,
} from "@sdp/types";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

/**
 * Product-level asynchronous exit routes.
 *
 * The discriminant belongs to the dashboard rather than to a provider id. A
 * second provider can reuse the queue flow by advertising the same mechanism,
 * while a provider with a different delayed-exit contract adds another union
 * member and renderer without teaching the exit chooser about that provider.
 */
export type EarnVaultAsyncWithdrawalRoute = {
  kind: "queue";
  summary: {
    messageKey: MessageKey;
    values: TranslationValues;
  };
  terms: EarnVaultQueuedWithdrawalTerms;
};

/** Product event emitted by a mechanism adapter, never a bare queue record. */
export type EarnVaultAsyncWithdrawalEvent = {
  kind: "queue";
  request: EarnVaultWithdrawalRequestRecord;
};

/** Convert today's wire-level queue fields into the extensible product route. */
export function earnVaultAsyncWithdrawalRoute(
  options: EarnVaultWithdrawalOptions
): EarnVaultAsyncWithdrawalRoute | null {
  if (!options.queued || options.queueAsset === null) return null;
  return {
    kind: "queue",
    summary: {
      messageKey: "DashboardEarn.exitRoute.asyncDescription",
      values: { seconds: options.queueAsset.secondsToMaturity },
    },
    terms: options.queueAsset,
  };
}
