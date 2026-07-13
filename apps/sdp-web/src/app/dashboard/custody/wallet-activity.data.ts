import type {
  PaymentTransferSummary,
  TokenTransaction,
  TokenTransactionListItem,
} from "@sdp/types";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import type { SdpApiClient } from "@/lib/sdp-api";
import { parseErrorMessage, readTransactionParam, toTitleCase } from "../activity-format-utils";
import { type FetchResult, fetchPaymentTransfers } from "../payments/payments-page.data";

export type WalletActivitySourceKind = "payments" | "issuance";

export interface WalletActivityRow {
  id: string;
  sourceKind: WalletActivitySourceKind;
  operationLabel: string;
  status: string;
  signature: string | null;
  token?: string;
  amount?: string;
  address?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface WalletActivityPayload {
  activityRows: WalletActivityRow[];
  activityError: string | null;
  activityNotice: string | null;
}

interface DashboardWalletActivityEnvelope {
  data?: Partial<WalletActivityPayload>;
  error?: {
    message?: string;
  };
}

const WALLET_ACTIVITY_LIMIT = 20;
type Translate = (key: MessageKey, values?: TranslationValues) => string;

function resolvePaymentOperation(transfer: PaymentTransferSummary, t: Translate): string {
  if (transfer.direction === "inbound") {
    return t("DashboardCustody.incoming");
  }
  if (transfer.direction === "outbound") {
    return t("DashboardCustody.outgoing");
  }
  return transfer.type ? toTitleCase(transfer.type) : t("DashboardCustody.transfer");
}

function resolvePaymentAddress(transfer: PaymentTransferSummary): string | undefined {
  if (transfer.direction === "inbound") {
    return transfer.source;
  }
  if (transfer.direction === "outbound") {
    return transfer.destination;
  }
  return transfer.destination ?? transfer.source;
}

function resolveIssuanceAddress(transaction: TokenTransaction): string | undefined {
  for (const key of [
    "source",
    "destination",
    "accountAddress",
    "tokenAccount",
    "currentAuthority",
    "newAuthority",
  ]) {
    const value = readTransactionParam(transaction.params, key);
    if (value !== null) {
      return String(value);
    }
  }

  return undefined;
}

function resolveIssuanceAmount(transaction: TokenTransaction): string | undefined {
  const amount = readTransactionParam(transaction.params, "amount");
  return amount === null ? undefined : String(amount);
}

export function buildWalletActivityRows(
  transfers: PaymentTransferSummary[],
  issuanceTransactions: TokenTransactionListItem[],
  t: Translate,
  limit = WALLET_ACTIVITY_LIMIT
): WalletActivityRow[] {
  const paymentRows = transfers.map((transfer) => ({
    id: `payment-${transfer.id}`,
    sourceKind: "payments" as const,
    operationLabel: resolvePaymentOperation(transfer, t),
    status: transfer.status,
    signature: transfer.signature,
    token: transfer.token,
    amount: transfer.amount,
    address: resolvePaymentAddress(transfer),
    createdAt: transfer.createdAt,
    updatedAt: transfer.updatedAt,
  }));

  const issuanceRows = issuanceTransactions.map(({ token, transaction }) => ({
    id: `issuance-${transaction.id}`,
    sourceKind: "issuance" as const,
    operationLabel: toTitleCase(transaction.type),
    status: transaction.status,
    signature: transaction.signature,
    token: token.symbol || token.name,
    amount: resolveIssuanceAmount(transaction),
    address: resolveIssuanceAddress(transaction),
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
  }));

  return [...paymentRows, ...issuanceRows]
    .sort((left, right) => {
      const leftTimestamp = Date.parse(left.createdAt ?? "") || 0;
      const rightTimestamp = Date.parse(right.createdAt ?? "") || 0;
      return rightTimestamp - leftTimestamp || right.id.localeCompare(left.id);
    })
    .slice(0, limit);
}

export async function fetchWalletIssuanceActivity(
  request: SdpApiClient["request"],
  walletId: string,
  t: Translate,
  pageSize = WALLET_ACTIVITY_LIMIT
): Promise<FetchResult<TokenTransactionListItem[]>> {
  try {
    const query = new URLSearchParams({
      walletId,
      page: "1",
      pageSize: String(pageSize),
    });

    const response = await request(`/v1/issuance/transactions?${query.toString()}`);
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: response.status,
        error: parseErrorMessage(body),
      };
    }

    const json = (await response.json()) as {
      data?: TokenTransactionListItem[];
    };

    return { ok: true, data: json.data ?? [] };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : t("DashboardCustody.unableToLoadIssuanceActivity"),
    };
  }
}

export async function loadWalletActivity(
  request: SdpApiClient["request"],
  walletId: string,
  t: Translate,
  options: { pageSize?: number } = {}
): Promise<FetchResult<WalletActivityPayload>> {
  const pageSize = options.pageSize ?? WALLET_ACTIVITY_LIMIT;

  const [paymentsResult, issuanceResult] = await Promise.all([
    fetchPaymentTransfers(request, pageSize, { walletId }),
    fetchWalletIssuanceActivity(request, walletId, t, pageSize),
  ]);

  const activityRows = buildWalletActivityRows(
    paymentsResult.data ?? [],
    issuanceResult.data ?? [],
    t,
    pageSize
  );
  const hasAvailableSource = paymentsResult.ok || issuanceResult.ok;
  const noticeParts: string[] = [];

  if (hasAvailableSource) {
    if (!paymentsResult.ok) {
      noticeParts.push(t("DashboardCustody.paymentsActivityUnavailable"));
    }
    if (!issuanceResult.ok) {
      noticeParts.push(t("DashboardCustody.issuanceActivityUnavailable"));
    }
  }

  const activityError = hasAvailableSource
    ? null
    : paymentsResult.status === 403 && issuanceResult.status === 403
      ? t("DashboardCustody.noActivitySources")
      : t("DashboardCustody.walletActivityUnavailable");

  return {
    ok: true,
    data: {
      activityRows,
      activityError,
      activityNotice: noticeParts.length > 0 ? noticeParts.join(" ") : null,
    },
  };
}

export async function fetchWalletActivity(
  walletId: string,
  options: { signal?: AbortSignal } = {}
): Promise<WalletActivityPayload> {
  const response = await fetch(`/api/dashboard/wallets/${encodeURIComponent(walletId)}/activity`, {
    method: "GET",
    cache: "no-store",
    signal: options.signal,
  });
  const body = (await response.json().catch(() => ({}))) as DashboardWalletActivityEnvelope;
  if (!response.ok) {
    throw new Error(body.error?.message ?? "");
  }

  return {
    activityRows: body.data?.activityRows ?? [],
    activityError: body.data?.activityError ?? null,
    activityNotice: body.data?.activityNotice ?? null,
  };
}
