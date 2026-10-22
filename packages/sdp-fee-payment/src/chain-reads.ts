/**
 * The Fee Payer's own chain reads, on the open scope's cluster's Kora upstream
 * (`createKoraUpstreamRpc`), so sponsorship pricing and settlement see the chain Kora simulates
 * against and never load the managed pool. The client itself stays in this package.
 */

// biome-ignore lint/style/noRestrictedImports: the Fee Payer's chain reads are the one caller of its Kora upstream door
import { createKoraUpstreamRpc } from "@sdp/rpc/factory";
import {
  getChainHeight,
  getRecentBlockhash,
  getSignatureStatuses,
  getTransaction,
  getTransactionNetworkFee,
  type ParsedTransaction,
  type SignatureStatusInfo,
} from "@sdp/rpc/solana";
import type { Signature, Slot } from "@solana/kit";

/**
 * A sponsored transaction's admission price on Kora's upstream: the network fee of the exact
 * compiled message at `confirmed` (a freshly fetched blockhash must price), and an upper bound on
 * the transaction's last valid block height.
 *
 * The bound is the latest blockhash's last valid block height from a bank at or past the slot
 * that priced the message. That bank's latest blockhash is at least as recent as the
 * transaction's, so the bound is never below the transaction's real last valid block height:
 * a release proven against it can only come late, never early. A node behind that slot errors on
 * `minContextSlot` instead of answering.
 *
 * @param transaction - The wire transaction to price.
 * @returns The fee in lamports and the last valid block height bound.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no Kora upstream.
 * @throws SdpRpcError `SOLANA_RPC_ERROR` when the upstream cannot price the message.
 */
export async function priceSponsoredTransaction(
  transaction: Uint8Array
): Promise<{ networkFee: bigint; lastValidBlockHeight: bigint }> {
  const rpc = createKoraUpstreamRpc();
  const priced = await getTransactionNetworkFee(rpc, transaction, "confirmed");
  const { lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed", priced.contextSlot);
  return { networkFee: priced.fee, lastValidBlockHeight };
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
 * Kora's upstream's `finalized` block height and slot, for budget reconciliation. Once the
 * finalized block height is past a transaction's last valid block height, every future block
 * descends from a block that can no longer include it, so the transaction can never land.
 *
 * @returns The finalized bank's block height and absolute slot.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no Kora upstream.
 */
export function sponsoredFinalizedHeight(): Promise<{ blockHeight: bigint; absoluteSlot: Slot }> {
  return getChainHeight(createKoraUpstreamRpc(), "finalized");
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
