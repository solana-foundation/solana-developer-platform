import type {
  EarnVaultParRedemptionTerms,
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
      waitSeconds: number;
    }
  | {
      kind: "provider_order";
      summary: EarnVaultAsyncWithdrawalSummary;
    }
  | {
      kind: "operator_redemption";
      summary: EarnVaultAsyncWithdrawalSummary;
      terms: EarnVaultParRedemptionTerms;
    };

/** Product event emitted by a mechanism adapter, never a bare queue record. */
export type EarnVaultAsyncWithdrawalEvent =
  | {
      kind: "queue";
      request: EarnVaultWithdrawalRequestRecord;
    }
  | {
      kind: "operator_redemption";
      request: EarnVaultWithdrawalRequestRecord;
    };

/** Convert today's wire-level queue fields into the extensible product route. */
export function earnVaultAsyncWithdrawalRoute(
  options: EarnVaultWithdrawalOptions
): EarnVaultAsyncWithdrawalRoute | null {
  const queueAsset = options.queued ? options.queueAsset : null;
  const hasQueue = queueAsset !== null;
  const parRedemption = options.parRedemption ?? null;
  // The chooser currently renders one delayed mechanism alongside an optional
  // atomic exit. Silently preferring among delayed contracts would hide a
  // materially different settlement model, so fail closed if the API ever
  // advertises more than one of them for a position.
  const delayedRouteCount =
    Number(hasQueue) + Number(options.providerOrder) + Number(!!parRedemption);
  if (delayedRouteCount > 1) return null;
  // Preserve the established queue route when it is live. The two mechanisms
  // are distinct: a queue has a cancellable request account; a provider order
  // transfers shares now and pays assets later outside that transaction.
  if (hasQueue) {
    return {
      kind: "queue",
      summary: {
        titleKey: "DashboardEarn.exitRoute.asyncTitle",
        messageKey: "DashboardEarn.exitRoute.asyncDescription",
        values: {},
      },
      terms: queueAsset,
      waitSeconds: queueAsset.secondsToMaturity,
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
  if (parRedemption) {
    return {
      kind: "operator_redemption",
      summary: {
        titleKey: "DashboardEarn.exitRoute.parTitle",
        messageKey: "DashboardEarn.exitRoute.parDescription",
        values: {},
      },
      terms: parRedemption,
    };
  }
  return null;
}
