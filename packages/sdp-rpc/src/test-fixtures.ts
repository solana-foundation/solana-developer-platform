import {
  address,
  blockhash,
  type GetTransactionApiResponseJsonParsed,
  lamports,
  type Signature,
  type TokenBalance,
  type TransactionError,
} from "@solana/kit";

export type JsonParsedTransactionResponse = GetTransactionApiResponseJsonParsed<0>;

export type JsonParsedTransactionMeta = NonNullable<JsonParsedTransactionResponse["meta"]>;

export type JsonParsedInstruction =
  JsonParsedTransactionResponse["transaction"]["message"]["instructions"][number];

const FIXTURE_SIGNATURE =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW" as Signature;

const FIXTURE_FEE_PAYER = address("US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx");

/**
 * Transaction metadata in the shape a `jsonParsed` `getTransaction` read returns it.
 *
 * @param params - The fields a test varies.
 * @param params.err - The execution error, or `null` for a successful transaction.
 * @param params.preTokenBalances - Token balances before the transaction.
 * @param params.postTokenBalances - Token balances after the transaction.
 * @returns Full metadata, with the deprecated `status` mirroring `err`.
 */
export function jsonParsedTransactionMeta(params: {
  err: TransactionError | null;
  preTokenBalances: readonly TokenBalance[];
  postTokenBalances: readonly TokenBalance[];
}): JsonParsedTransactionMeta {
  return {
    computeUnitsConsumed: 4_500n,
    err: params.err,
    fee: lamports(5_000n),
    innerInstructions: [],
    logMessages: [],
    postBalances: [lamports(999_995_000n)],
    postTokenBalances: params.postTokenBalances,
    preBalances: [lamports(1_000_000_000n)],
    preTokenBalances: params.preTokenBalances,
    rewards: [],
    status: params.err === null ? { Ok: null } : { Err: params.err },
  };
}

/**
 * A version-0 transaction as a `jsonParsed` `getTransaction` read returns it.
 *
 * @param params - The fields a test varies.
 * @param params.meta - The transaction metadata, or `null` when the RPC has none.
 * @param params.instructions - The top-level instructions.
 * @returns The full response.
 */
export function jsonParsedTransactionResponse(params: {
  meta: JsonParsedTransactionMeta | null;
  instructions: readonly JsonParsedInstruction[];
}): JsonParsedTransactionResponse {
  return {
    blockTime: null,
    meta: params.meta,
    slot: 100n,
    transaction: {
      message: {
        accountKeys: [
          { pubkey: FIXTURE_FEE_PAYER, signer: true, source: "transaction", writable: true },
        ],
        addressTableLookups: [],
        instructions: params.instructions,
        recentBlockhash: blockhash("cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN"),
      },
      signatures: [FIXTURE_SIGNATURE],
    },
    version: 0,
  };
}
