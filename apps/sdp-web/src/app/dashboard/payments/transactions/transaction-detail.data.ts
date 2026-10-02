import type {
  PaymentTransferEnvelope,
  PaymentTransferSummary,
  UnifiedTransaction,
  UnifiedTransactionsListResponse,
} from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";
import { readableApiError } from "@/lib/sdp-api-error";

/** The transfer record as the API returns it, with the network fee the shared type leaves out. */
export type PaymentTransferDetail = PaymentTransferSummary & {
  /** The Solana fee in lamports, once the transaction landed. */
  fee?: number | null;
};

export type TransactionDetailResult =
  | { status: "found"; transaction: UnifiedTransaction; transfer: PaymentTransferDetail | null }
  | { status: "not_found" }
  | { status: "error"; error: string };

// The ledger's search matches an id as a prefix, so a whole id finds itself on the first page;
// the page is only there for a module id or signature that happens to share it.
const SEARCH_LIMIT = 25;

/**
 * One ledger transaction by id. The ledger has no read of a single row, so this searches for
 * the id and keeps the exact match. A payment also reads its transfer record, which carries
 * the source, destination, memo, provider and fee; if that read fails the page still has the
 * ledger row.
 *
 * @param apiClient - Authenticated SDP API client.
 * @param transactionId - The ledger id (a payment's is its transfer id).
 * @returns The row and, for a payment, its transfer; `not_found`; or the load error. Never throws.
 */
export async function fetchTransactionDetail(
  apiClient: SdpApiClient,
  transactionId: string
): Promise<TransactionDetailResult> {
  let transaction: UnifiedTransaction | undefined;
  try {
    const query = new URLSearchParams({ search: transactionId, limit: String(SEARCH_LIMIT) });
    const list = await apiClient.fetch<UnifiedTransactionsListResponse>(
      `/v1/transactions?${query}`
    );
    transaction = list.transactions.find((row) => row.id === transactionId);
  } catch (error) {
    return { status: "error", error: readableApiError(error) };
  }
  if (!transaction) return { status: "not_found" };
  if (transaction.module !== "payments") return { status: "found", transaction, transfer: null };

  try {
    const response = await apiClient.request(
      `/v1/payments/transfers/${encodeURIComponent(transaction.moduleId)}`
    );
    const envelope = response.ok ? ((await response.json()) as PaymentTransferEnvelope) : null;
    const transfer = (envelope?.data?.transfer as PaymentTransferDetail | undefined) ?? null;
    return { status: "found", transaction, transfer };
  } catch {
    return { status: "found", transaction, transfer: null };
  }
}
