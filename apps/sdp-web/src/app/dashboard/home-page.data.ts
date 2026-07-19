import type {
  PaymentTransferSummary,
  TokenTransaction,
  TokenTransactionListItem,
} from "@sdp/types";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import type { SdpApiClient } from "@/lib/sdp-api";
import { parseErrorMessage, readTransactionParam, toTitleCase } from "./activity-format-utils";
import type { FetchResult } from "./payments/payments-page.data";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export interface HomeActivityRow {
  id: string;
  createdAt: string;
  type: string;
  token: string;
  amount: string;
  address: string;
  sourceKind: "payments" | "issuance";
}

function resolveIssuanceAmount(transaction: TokenTransaction): string {
  const amount = readTransactionParam(transaction.params, "amount");
  if (amount === null) {
    return "—";
  }
  return String(amount);
}

function resolveIssuanceAddress(transaction: TokenTransaction): string {
  const destination = readTransactionParam(transaction.params, "destination");
  if (destination !== null) {
    return String(destination);
  }

  const source = readTransactionParam(transaction.params, "source");
  if (source !== null) {
    return String(source);
  }

  if (transaction.signature) {
    return transaction.signature;
  }

  return "—";
}

function resolvePaymentsType(transfer: PaymentTransferSummary, t: Translate): string {
  if (transfer.direction === "outbound") {
    return t("Shared.homeWorkspace.send");
  }

  if (transfer.direction === "inbound") {
    return t("Shared.homeWorkspace.receive");
  }

  return transfer.type ? toTitleCase(transfer.type) : t("Shared.homeWorkspace.transfer");
}

function resolvePaymentsAddress(transfer: PaymentTransferSummary): string {
  if (transfer.direction === "outbound") {
    return transfer.destination ?? "—";
  }

  if (transfer.direction === "inbound") {
    return transfer.source ?? "—";
  }

  return transfer.destination ?? transfer.source ?? "—";
}

export function computeTodaysVolume(transfers: PaymentTransferSummary[]): number | null {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let hasNumericAmount = false;

  const total = transfers.reduce((sum, transfer) => {
    if (!transfer.createdAt) {
      return sum;
    }

    const createdAt = new Date(transfer.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt < startOfDay) {
      return sum;
    }

    const amount = Number(transfer.amount);
    if (!Number.isFinite(amount)) {
      return sum;
    }

    hasNumericAmount = true;
    return sum + amount;
  }, 0);

  return hasNumericAmount ? total : null;
}

export function buildHomeActivityRows(
  transfers: PaymentTransferSummary[],
  issuanceTransactions: TokenTransactionListItem[],
  t: Translate
): HomeActivityRow[] {
  const paymentRows = transfers
    .filter(
      (transfer): transfer is PaymentTransferSummary & { createdAt: string } =>
        typeof transfer.createdAt === "string" && transfer.createdAt.length > 0
    )
    .map((transfer) => ({
      id: `payment-${transfer.id}`,
      createdAt: transfer.createdAt,
      type: resolvePaymentsType(transfer, t),
      token: transfer.token ?? "—",
      amount: transfer.amount ?? "—",
      address: resolvePaymentsAddress(transfer),
      sourceKind: "payments" as const,
    }));

  const issuanceRows = issuanceTransactions
    .filter(
      (
        entry
      ): entry is typeof entry & {
        transaction: TokenTransaction & { createdAt: string };
      } => typeof entry.transaction.createdAt === "string" && entry.transaction.createdAt.length > 0
    )
    .map(({ token, transaction }) => ({
      id: `issuance-${transaction.id}`,
      createdAt: transaction.createdAt,
      type: toTitleCase(transaction.type),
      token: token.symbol || token.name || "—",
      amount: resolveIssuanceAmount(transaction),
      address: resolveIssuanceAddress(transaction),
      sourceKind: "issuance" as const,
    }));

  return [...paymentRows, ...issuanceRows]
    .sort((left, right) => {
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    })
    .slice(0, 10);
}

export async function fetchOrgIssuanceActivity(
  request: SdpApiClient["request"],
  t: Translate,
  pageSize = 20
): Promise<FetchResult<TokenTransactionListItem[]>> {
  try {
    const response = await request(
      `/v1/issuance/transactions?${new URLSearchParams({
        page: "1",
        pageSize: String(pageSize),
      }).toString()}`
    );
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: response.status,
        error: parseErrorMessage(body),
      };
    }

    const json = (await response.json()) as { data?: TokenTransactionListItem[] };
    return { ok: true, data: json.data ?? [] };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : t("Shared.homeWorkspace.issuanceActivityUnavailable"),
    };
  }
}
