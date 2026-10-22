/**
 * The Fee Payer's own chain reads, on the open scope's cluster's Kora upstream
 * (`createKoraUpstreamRpc`), so sponsorship pricing and settlement see the chain Kora simulates
 * against and never load the managed pool. The client itself stays in this package.
 */

// biome-ignore lint/style/noRestrictedImports: the Fee Payer's chain reads are the one caller of its Kora upstream door
import { createKoraUpstreamRpc } from "@sdp/rpc/factory";
import {
  getBlockhashValidity,
  getSignatureStatuses,
  getTransaction,
  getTransactionNetworkFee,
  type ParsedTransaction,
  type SignatureStatusInfo,
} from "@sdp/rpc/solana";
import type { Blockhash, Signature, Slot } from "@solana/kit";

/**
 * The network fee of the exact compiled message, priced on Kora's upstream.
 *
 * @param transaction - The wire transaction to price.
 * @returns The fee in lamports.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no Kora upstream.
 */
export function sponsoredNetworkFee(transaction: Uint8Array): Promise<bigint> {
  return getTransactionNetworkFee(createKoraUpstreamRpc(), transaction);
}

/**
 * A sponsored transaction as Kora's upstream sees it at `finalized`, for budget reconciliation:
 * settlement never commits spend from a block that can still be rolled back.
 *
 * @param signature - The transaction signature.
 * @returns The parsed transaction, or null when the upstream has not finalized it.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no Kora upstream.
 */
export function getSponsoredTransaction(signature: Signature): Promise<ParsedTransaction | null> {
  return getTransaction(createKoraUpstreamRpc(), signature, "finalized");
}

/**
 * Whether a sponsored transaction's blockhash can still land, per Kora's upstream's `finalized`
 * bank. Once the finalized bank says the blockhash is invalid, every future block descends from a
 * block past the transaction's last valid block height, so the transaction can never land.
 *
 * @param blockhash - The transaction's recent blockhash.
 * @returns Whether the blockhash is valid at `finalized`, and the slot that answer was read at.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no Kora upstream.
 */
export function sponsoredBlockhashValidity(
  blockhash: Blockhash
): Promise<{ valid: boolean; contextSlot: Slot }> {
  return getBlockhashValidity(createKoraUpstreamRpc(), blockhash, "finalized");
}

/**
 * A sponsored transaction's signature status as Kora's upstream sees it, searching ledger history
 * as well as the recent status cache, so budget reconciliation can tell a transaction that landed
 * (including one that failed, which still pays its fee) from one that never did.
 *
 * @param signature - The transaction signature.
 * @param minContextSlot - The lowest slot the answering node may be at; a node behind it errors
 * instead of answering, so a lagging node cannot report a landed transaction as absent.
 * @returns The signature's status, or null when the upstream has no record of it.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no Kora upstream.
 */
export async function getSponsoredSignatureStatus(
  signature: Signature,
  minContextSlot: Slot
): Promise<SignatureStatusInfo | null> {
  const [status] = await getSignatureStatuses(createKoraUpstreamRpc(), [signature], {
    searchTransactionHistory: true,
    minContextSlot,
  });
  return status;
}
