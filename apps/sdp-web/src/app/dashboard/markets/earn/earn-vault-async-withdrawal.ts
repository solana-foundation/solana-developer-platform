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
type EarnVaultAsyncWithdrawalSummary = {
  titleKey: MessageKey;
  messageKey: MessageKey;
  values: TranslationValues;
};

export type EarnVaultAsyncWithdrawalRoute =
  | {
      kind: "queue";
      summary: EarnVaultAsyncWithdrawalSummary;
      terms: EarnVaultQueuedWithdrawalTerms;
    }
  | {
      kind: "provider_order";
      summary: EarnVaultAsyncWithdrawalSummary;
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
  const queueAsset = options.queued ? options.queueAsset : null;
  const hasQueue = queueAsset !== null;
  // The chooser currently renders one delayed mechanism. If the API ever
  // advertises two, silently preferring either would hide a materially
  // different exit contract; fail closed until the chooser can present both.
  if (hasQueue && options.providerOrder) return null;
  // Preserve the established queue route when it is live. The two mechanisms
  // are distinct: a queue has a cancellable request account; a provider order
  // transfers shares now and pays assets later outside that transaction.
  if (hasQueue) {
    return {
      kind: "queue",
      summary: {
        titleKey: "DashboardEarn.exitRoute.asyncTitle",
        messageKey: "DashboardEarn.exitRoute.asyncDescription",
        values: { seconds: queueAsset.secondsToMaturity },
      },
      terms: queueAsset,
    };
  }
  if (options.providerOrder) {
    return {
      kind: "provider_order",
      summary: {
        titleKey: "DashboardEarn.exitRoute.providerOrderTitle",
        messageKey: "DashboardEarn.exitRoute.providerOrderDescription",
        values: {},
      },
    };
  }
  return null;
}
