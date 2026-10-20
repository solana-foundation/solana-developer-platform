/**
 * The Fee Payer's own chain reads, on the open scope's cluster's Kora upstream
 * (`createKoraUpstreamRpc`), so sponsorship pricing and settlement see the chain Kora simulates
 * against and never load the managed pool. The client itself stays in this package.
 */

// biome-ignore lint/style/noRestrictedImports: the Fee Payer's chain reads are the one caller of its Kora upstream door
import { createKoraUpstreamRpc } from "@sdp/rpc/factory";
import {
  getTransaction,
  getTransactionNetworkFee,
  isBlockhashValid,
  type ParsedTransaction,
} from "@sdp/rpc/solana";
import type { Blockhash, Signature } from "@solana/kit";

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
 * A sponsored transaction as Kora's upstream sees it, for budget reconciliation.
 *
 * @param signature - The transaction signature.
 * @returns The parsed transaction, or null when the upstream has not seen it.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no Kora upstream.
 */
export function getSponsoredTransaction(signature: Signature): Promise<ParsedTransaction | null> {
  return getTransaction(createKoraUpstreamRpc(), signature);
}

/**
 * Whether a sponsored transaction's blockhash can still land, per Kora's upstream.
 *
 * @param blockhash - The transaction's recent blockhash.
 * @returns True while the blockhash is valid.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no Kora upstream.
 */
export function isSponsoredBlockhashValid(blockhash: Blockhash): Promise<boolean> {
  return isBlockhashValid(createKoraUpstreamRpc(), blockhash);
}
