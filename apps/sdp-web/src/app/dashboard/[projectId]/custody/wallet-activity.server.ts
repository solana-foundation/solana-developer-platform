import type { FetchResult } from "@/app/dashboard/[projectId]/payments/payments-page.data";
import { issuance } from "@/flags";
import type { SdpApiClient } from "@/lib/sdp-api";
import {
  buildWalletActivityRows,
  fetchWalletIssuanceActivity,
  fetchWalletPaymentActivity,
  type Translate,
  WALLET_ACTIVITY_LIMIT,
  type WalletActivityIdentity,
  type WalletActivityPayload,
} from "./wallet-activity.data";

/**
 * One wallet's activity: payment transfers merged with issuance transactions, newest first.
 * Issuance is a source only where its flag is on: off, it is never read and never counts toward
 * whether the history loaded, so a failed payments read still reports its error.
 *
 * @param request - The request-scoped SDP API client's `request`.
 * @param wallet - The wallet's SDP and provider ids.
 * @param t - Translator for row labels and notices.
 * @param options - `pageSize` widens the window.
 * @returns The merged rows, a notice for a source that failed, and whether older rows exist.
 */
export async function loadWalletActivity(
  request: SdpApiClient["request"],
  wallet: WalletActivityIdentity,
  t: Translate,
  options: { pageSize?: number } = {}
): Promise<FetchResult<WalletActivityPayload>> {
  const pageSize = options.pageSize ?? WALLET_ACTIVITY_LIMIT;
  const issuanceEnabled = await issuance();

  const [paymentsResult, issuanceResult] = await Promise.all([
    fetchWalletPaymentActivity(request, wallet.custodyWalletId, pageSize),
    issuanceEnabled
      ? fetchWalletIssuanceActivity(request, wallet.custodyWalletId, t, pageSize)
      : null,
  ]);
  const sources = issuanceResult === null ? [paymentsResult] : [paymentsResult, issuanceResult];

  const transfers = paymentsResult.data ?? [];
  const issuanceTransactions = issuanceResult?.data ?? [];
  const activityRows = buildWalletActivityRows(transfers, issuanceTransactions, t, pageSize);
  const hasMore =
    transfers.length >= pageSize ||
    issuanceTransactions.length >= pageSize ||
    transfers.length + issuanceTransactions.length > pageSize;
  const hasAvailableSource = sources.some((source) => source.ok);
  const noticeParts: string[] = [];

  if (hasAvailableSource) {
    if (!paymentsResult.ok) {
      noticeParts.push(t("DashboardCustody.paymentsActivityUnavailable"));
    }
    if (issuanceResult !== null && !issuanceResult.ok) {
      noticeParts.push(t("DashboardCustody.issuanceActivityUnavailable"));
    }
  }

  let activityError: string | null = null;
  if (!hasAvailableSource) {
    activityError = sources.every((source) => source.status === 403)
      ? t("DashboardCustody.noActivitySources")
      : t("DashboardCustody.walletActivityUnavailable");
  }

  return {
    ok: true,
    data: {
      activityRows,
      activityError,
      activityNotice: noticeParts.length > 0 ? noticeParts.join(" ") : null,
      hasMore,
    },
  };
}
