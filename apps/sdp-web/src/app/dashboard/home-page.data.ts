import type { PaymentTransferSummary, TokenTransaction } from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";
import type { FetchResult } from "./payments/payments-page.data";

interface HomeIssuanceToken {
  id: string;
  name: string;
  symbol: string;
}

export interface HomeActivityRow {
  id: string;
  createdAt: string;
  type: string;
  token: string;
  amount: string;
  address: string;
  sourceKind: "payments" | "issuance";
}

function parseErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    return parsed?.error?.message ?? parsed?.message ?? body;
  } catch {
    return body || "Unknown error";
  }
}

function toTitleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(" ");
}

function readTransactionParam(
  params: Record<string, unknown>,
  key: string
): string | number | null {
  const value = params[key];
  return typeof value === "string" || typeof value === "number" ? value : null;
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

function resolvePaymentsType(transfer: PaymentTransferSummary): string {
  if (transfer.direction === "outbound") {
    return "Send";
  }

  if (transfer.direction === "inbound") {
    return "Receive";
  }

  return transfer.type ? toTitleCase(transfer.type) : "Transfer";
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
  issuanceTransactions: Array<{
    tokenName: string;
    tokenSymbol: string;
    transaction: TokenTransaction;
  }>
): HomeActivityRow[] {
  const paymentRows = transfers
    .filter(
      (transfer): transfer is PaymentTransferSummary & { createdAt: string } =>
        typeof transfer.createdAt === "string" && transfer.createdAt.length > 0
    )
    .map((transfer) => ({
      id: `payment-${transfer.id}`,
      createdAt: transfer.createdAt,
      type: resolvePaymentsType(transfer),
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
    .map(({ tokenName, tokenSymbol, transaction }) => ({
      id: `issuance-${transaction.id}`,
      createdAt: transaction.createdAt,
      type: toTitleCase(transaction.type),
      token: tokenSymbol || tokenName || "—",
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

export async function fetchIssuanceTokens(
  request: SdpApiClient["request"],
  pageSize = 100
): Promise<FetchResult<HomeIssuanceToken[]>> {
  try {
    const response = await request(
      `/v1/issuance/tokens?${new URLSearchParams({
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

    const json = (await response.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        symbol?: string;
      }>;
    };

    const tokens = (json?.data ?? [])
      .filter(
        (
          token
        ): token is {
          id: string;
          name?: string;
          symbol?: string;
        } => typeof token?.id === "string"
      )
      .map((token) => ({
        id: token.id,
        name: token.name ?? "Untitled token",
        symbol: token.symbol ?? "—",
      }));

    return { ok: true, data: tokens };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load issuance tokens",
    };
  }
}

export async function fetchOrgIssuanceActivity(
  request: SdpApiClient["request"],
  tokens: HomeIssuanceToken[]
): Promise<{
  rows: Array<{
    tokenName: string;
    tokenSymbol: string;
    transaction: TokenTransaction;
  }>;
  error: string | null;
}> {
  const settledTransactions = await Promise.allSettled(
    tokens.map(async (token) => {
      const response = await request(
        `/v1/issuance/tokens/${token.id}/transactions?${new URLSearchParams({
          page: "1",
          pageSize: "10",
        }).toString()}`
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(parseErrorMessage(body));
      }

      const json = (await response.json()) as {
        data?: TokenTransaction[];
      };

      return (json.data ?? []).map((transaction) => ({
        tokenName: token.name,
        tokenSymbol: token.symbol,
        transaction,
      }));
    })
  );

  const rows: Array<{
    tokenName: string;
    tokenSymbol: string;
    transaction: TokenTransaction;
  }> = [];
  let hasFailure = false;

  for (const result of settledTransactions) {
    if (result.status === "fulfilled") {
      rows.push(...result.value);
      continue;
    }

    hasFailure = true;
  }

  return {
    rows,
    error: hasFailure ? "Some issuance activity could not be loaded." : null,
  };
}
