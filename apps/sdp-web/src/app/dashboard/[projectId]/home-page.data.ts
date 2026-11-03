import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import {
  isSuccessfulPaymentTransferStatus,
  PAYMENT_TRANSFER_STATUSES,
  type PaymentTransferSummary,
} from "@sdp/types/payments";
import {
  TOKEN_TRANSACTION_STATUSES,
  type TokenTransaction,
  type TokenTransactionListItem,
} from "@sdp/types/tokens";
import { z } from "zod";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";
import { parseErrorMessage } from "@/lib/api-error";
import type { SdpApiClient } from "@/lib/sdp-api";
import { readTransactionParam, toTitleCase } from "./activity-format-utils";
import { resolveTransferTokenLabel, resolveUsdUnitPrice } from "./payments/payments-overview.utils";
import type { FetchResult } from "./payments/payments-page.data";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

const homeActivityExplorerRefSchema = z.object({
  kind: z.enum(["tx", "address"]),
  value: z.string(),
});

/** One recent-activity row: what the activity route builds and the browser parses back. */
export const homeActivityRowSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  type: z.string(),
  token: z.string(),
  // Raw mint behind `token`, when there is one. `token` is already resolved here,
  // but this builder only sees issued-token symbols, so a holding the organization
  // did not issue degrades to a shortened mint. Carrying the mint lets the client,
  // which has the symbols that came back with the balances, name it properly.
  tokenMint: z.string().nullable(),
  amount: z.string(),
  status: z.union([z.enum(PAYMENT_TRANSFER_STATUSES), z.enum(TOKEN_TRANSACTION_STATUSES)]),
  address: z.string(),
  explorer: homeActivityExplorerRefSchema.nullable(),
  sourceKind: z.enum(["payments", "issuance"]),
});

export type HomeActivityExplorerRef = z.infer<typeof homeActivityExplorerRefSchema>;
export type HomeActivityRow = z.infer<typeof homeActivityRowSchema>;

/**
 * Filters cached Home activity through the current module flags. The API route
 * applies the same gate, but this client-side seam prevents a persisted SWR
 * snapshot from briefly resurfacing Issuance rows after the flag is disabled.
 */
export function filterHomeActivityRowsByFlags(
  rows: readonly HomeActivityRow[],
  flags: { issuance: boolean }
): HomeActivityRow[] {
  return flags.issuance ? [...rows] : rows.filter((row) => row.sourceKind !== "issuance");
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

// Prefer the counterparty address (what the row shows) and fall back to the tx signature so the
// row is still linkable before an address is known. Cluster is applied later, in the client.
function resolvePaymentsExplorer(transfer: PaymentTransferSummary): HomeActivityExplorerRef | null {
  const address = resolvePaymentsAddress(transfer);
  if (address !== "—") {
    return { kind: "address", value: address };
  }
  if (transfer.signature) {
    return { kind: "tx", value: transfer.signature };
  }
  return null;
}

function resolveIssuanceExplorer(transaction: TokenTransaction): HomeActivityExplorerRef | null {
  const destination = readTransactionParam(transaction.params, "destination");
  if (destination !== null) {
    return { kind: "address", value: String(destination) };
  }
  const source = readTransactionParam(transaction.params, "source");
  if (source !== null) {
    return { kind: "address", value: String(source) };
  }
  if (transaction.signature) {
    return { kind: "tx", value: transaction.signature };
  }
  return null;
}

export const todaysVolumeSchema = z.object({
  /** Successful transfers created since 00:00 UTC. */
  transferCount: z.number().int().nonnegative(),
  /** What they moved, summed per mint: SOL and USDC amounts do not add. */
  amountByMint: z.record(z.string(), z.number()),
  /** False when a counted transfer had no token or no readable amount, so the sums miss it. */
  complete: z.boolean(),
});

export type TodaysVolume = z.infer<typeof todaysVolumeSchema>;

/**
 * Today's successful transfers and what they moved, per mint. Only a successful transfer moved
 * value: a pending one may still fail, and a failed, canceled or unpaid one moved nothing. Home
 * prices the amounts with the balance read it already has (`priceTodaysVolume`).
 */
export function computeTodaysVolume(transfers: PaymentTransferSummary[]): TodaysVolume {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const amountByMint: Record<string, number> = {};
  let transferCount = 0;
  let complete = true;

  for (const transfer of transfers) {
    if (!transfer.createdAt || !isSuccessfulPaymentTransferStatus(transfer.status)) {
      continue;
    }

    const createdAt = new Date(transfer.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt < startOfDay) {
      continue;
    }

    transferCount += 1;
    const mint = transfer.token?.trim();
    const amount = Number(transfer.amount);
    if (!mint || !Number.isFinite(amount)) {
      complete = false;
      continue;
    }

    amountByMint[mint] = (amountByMint[mint] ?? 0) + amount;
  }

  return { transferCount, amountByMint, complete };
}

/** Home's volume figure: dollars when every transfer today has a price, otherwise how many. */
export type TodaysVolumeFigure = { kind: "usd"; usd: number } | { kind: "count"; count: number };

/**
 * Prices today's volume with the balances on screen, which carry the API's market price for
 * each mint held. A transfer in a token with no price makes a dollar sum wrong, not smaller, so
 * the day reads as a count instead.
 */
export function priceTodaysVolume(
  volume: TodaysVolume,
  balances: readonly CustodyWalletTokenBalance[]
): TodaysVolumeFigure {
  if (!volume.complete) {
    return { kind: "count", count: volume.transferCount };
  }

  let usd = 0;
  for (const [mint, amount] of Object.entries(volume.amountByMint)) {
    const usdPrice = resolveUsdUnitPrice(mint, balances);
    if (usdPrice === null) {
      return { kind: "count", count: volume.transferCount };
    }
    usd += amount * usdPrice;
  }

  return { kind: "usd", usd };
}

export function buildHomeActivityRows(
  transfers: PaymentTransferSummary[],
  issuanceTransactions: TokenTransactionListItem[],
  t: Translate,
  /** Symbols for tokens this org issued, keyed by mint. The catalogue never knows them. */
  issuedTokenSymbolsByMint?: Readonly<Record<string, string>>
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
      // transfer.token is a mint address; without this the row renders the raw
      // base58 while the Transactions table shows the symbol for the same row.
      token: resolveTransferTokenLabel(transfer.token, issuedTokenSymbolsByMint) ?? "—",
      tokenMint: transfer.token?.trim() || null,
      amount: transfer.amount ?? "—",
      status: transfer.status,
      address: resolvePaymentsAddress(transfer),
      explorer: resolvePaymentsExplorer(transfer),
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
      tokenMint: token.mintAddress?.trim() || null,
      amount: resolveIssuanceAmount(transaction),
      status: transaction.status,
      address: resolveIssuanceAddress(transaction),
      explorer: resolveIssuanceExplorer(transaction),
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
