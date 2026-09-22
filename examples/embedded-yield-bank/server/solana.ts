import "server-only";

import {
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type KeyPairSigner,
  partiallySignTransaction,
} from "@solana/kit";
import { z } from "zod";
import { formatAtoms } from "../src/lib/decimal";
import type { TokenBalance } from "../src/types";

export type SolanaCluster = "devnet" | "mainnet-beta";

const rpcEnvelopeSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

const tokenAccountsSchema = z.object({
  value: z.array(
    z.object({
      account: z.object({
        data: z.object({
          parsed: z.object({
            info: z.object({
              tokenAmount: z.object({
                amount: z.string().regex(/^\d+$/),
                decimals: z.number().int().min(0).max(30),
              }),
            }),
          }),
        }),
      }),
    })
  ),
});

export const USDC_MINTS = {
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
} as const satisfies Record<SolanaCluster, string>;

const GENESIS_HASHES = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
} as const satisfies Record<SolanaCluster, string>;

const KNOWN_TOKENS: Record<string, string> = {
  [USDC_MINTS.devnet]: "USDC",
  [USDC_MINTS["mainnet-beta"]]: "USDC",
};

let verifiedRpc: { rpcUrl: string; cluster: SolanaCluster } | undefined;

export interface SignTransactionOptions {
  /**
   * The dedicated sponsor's address when one co-signs. Absent means the owner
   * pays fees, so there is no second wallet to fence off.
   */
  feePayerAddress?: string;
}

export async function signTransaction(
  transactionBase64: string,
  signers: readonly KeyPairSigner[],
  options: SignTransactionOptions = {}
): Promise<string> {
  const transaction = getTransactionDecoder().decode(
    Buffer.from(transactionBase64, "base64")
  );
  assertRequiredSigners(transaction, signers);
  assertFeePayerSlot(
    transaction,
    options.feePayerAddress ?? signers[0]?.address
  );
  const signed = await partiallySignTransaction(
    signers.map((signer) => signer.keyPair),
    transaction
  );
  return getBase64EncodedWireTransaction(signed);
}

/**
 * The demo signs whatever bytes SDP built, so the bytes are checked against
 * the signer set before any key touches them. The fee-payer echo in the build
 * JSON (`assertBuiltFeePayer`) is not a check over the transaction itself: a
 * malicious build response can echo it correctly while swapping the wire
 * bytes, and both demo keys would then sign a transaction that drains one
 * wallet while requiring only the other key's signature. The decoded
 * signature slots are the authority — the fee payer takes slot zero and every
 * further required signer follows — so the exact-set check refuses a build
 * that does not require exactly the configured signers, and nothing else.
 */
function assertRequiredSigners(
  transaction: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>,
  signers: readonly KeyPairSigner[]
): void {
  const required = new Set(Object.keys(transaction.signatures));
  const provided = new Set<string>(signers.map((signer) => signer.address));
  if (
    required.size !== provided.size ||
    [...required].some((address) => !provided.has(address))
  ) {
    throw new Error(
      "SDP returned a transaction that does not require exactly the configured signer set"
    );
  }
}

/**
 * The fee payer must really be at static slot zero. The echo check compares
 * JSON; this compares the bytes a signature actually commits to. (Whether an
 * instruction may SPEND the fee payer is not decodable from the wire — roles
 * are not encoded, and an honest build names the fee payer as the rent payer
 * of an ATA create — so spending is fenced by the simulated balance deltas
 * below instead.)
 */
function assertFeePayerSlot(
  transaction: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>,
  expectedFeePayer: string | undefined
): void {
  if (!expectedFeePayer) return;
  const message = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes
  );
  if (message.staticAccounts[0] !== expectedFeePayer) {
    throw new Error(
      "SDP returned a transaction whose fee payer does not match the configured signer"
    );
  }
}

/** The customer's balance of the savings token: one RPC call per refresh. */
export async function readTokenBalance(
  rpcUrl: string,
  ownerAddress: string,
  mint: string
): Promise<TokenBalance> {
  const result = await rpcCall(rpcUrl, "getTokenAccountsByOwner", [
    ownerAddress,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  const accounts = tokenAccountsSchema.parse(result).value;
  const decimals =
    accounts[0]?.account.data.parsed.info.tokenAmount.decimals ?? 0;
  const atoms = accounts.reduce((total, account) => {
    const amount = account.account.data.parsed.info.tokenAmount;
    if (amount.decimals !== decimals)
      throw new Error(`Inconsistent decimals for token mint ${mint}`);
    return total + BigInt(amount.amount);
  }, 0n);

  return {
    mint,
    symbol: KNOWN_TOKENS[mint] ?? `Token ${mint.slice(0, 4)}`,
    amount: formatAtoms(atoms, decimals),
    decimals,
  };
}

/** Fail closed before reading balances or signing against the wrong cluster. */
export async function assertRpcCluster(
  rpcUrl: string,
  cluster: SolanaCluster
): Promise<void> {
  if (verifiedRpc?.rpcUrl === rpcUrl && verifiedRpc.cluster === cluster) return;

  const observed = z
    .string()
    .parse(await rpcCall(rpcUrl, "getGenesisHash", []));
  if (observed !== GENESIS_HASHES[cluster]) {
    throw new Error(
      `SOLANA_RPC_URL does not serve ${cluster}; refusing to continue`
    );
  }
  verifiedRpc = { rpcUrl, cluster };
}

const tokenBalanceRowsSchema = z.array(
  z.object({
    owner: z.string(),
    mint: z.string(),
    uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }),
  })
);

const lamportsSchema = z
  .string()
  .regex(/^\d+$/)
  .or(z.number().int().nonnegative());

const simulationSchema = z.object({
  value: z.object({
    err: z.unknown().nullish(),
    // Aligned with the account list: static accounts first, so the signer
    // slots (fee payer, then owner) sit at fixed indexes.
    preBalances: z.array(lamportsSchema).optional(),
    postBalances: z.array(lamportsSchema).optional(),
    preTokenBalances: tokenBalanceRowsSchema.optional(),
    postTokenBalances: tokenBalanceRowsSchema.optional(),
  }),
});

export interface SimulatedOwnerDelta {
  ownerAddress: string;
  mint: string;
  /** Required owner delta in the mint's atoms. */
  atoms: bigint;
  /**
   * `exact` for a deposit (the transaction must move precisely the requested
   * amount out of the owner), `atLeast` for a withdrawal (the payout must
   * clear the derived floor).
   */
  tolerance: "exact" | "atLeast";
  /**
   * The dedicated sponsor's address when one co-signs. Its signature is for
   * fees and rent; the simulated SOL deltas fence it against anything more.
   */
  feePayerAddress?: string;
}

/**
 * A fee or rent payment costs well under this; any larger drop in a signer's
 * SOL balance is a drain, whatever instruction shape carried it.
 */
const MAX_FEE_AND_RENT_LAMPORTS = 10_000_000n;

/**
 * The last content check before submission, and the only one that sees
 * INTENT: signer shapes and the fee-payer slot cannot read a vault
 * instruction's amount, and wire roles cannot distinguish a rent payer from
 * a spend authority. The signed transaction is simulated against the same
 * RPC instead, and the balances must move exactly as requested:
 *
 * - the owner's savings-token delta is exactly (deposit) or at least
 *   (withdrawal) the requested amount, so a build that moves the owner's
 *   tokens anywhere else is refused however it is shaped;
 * - each signer's SOL delta is bounded by fees plus rent, so the sponsor (or
 *   an unsponsored owner) cannot be drained through rent or authority tricks.
 *
 * A simulation RPC failure fails closed: the transfer is not submitted on a
 * check we could not run.
 */
export async function assertSimulatedOwnerTokenDelta(
  rpcUrl: string,
  signedTransactionBase64: string,
  input: SimulatedOwnerDelta
): Promise<void> {
  const result = await rpcCall(rpcUrl, "simulateTransaction", [
    signedTransactionBase64,
    // The blockhash is seconds old, but replacing it keeps the simulation
    // valid even when a build sat at the edge of its ~1 minute expiry.
    { encoding: "base64", replaceRecentBlockhash: true, sigVerify: false },
  ]);
  const simulation = simulationSchema.parse(result);
  if (simulation.value.err != null) {
    throw new Error(
      `Simulated SDP transaction failed on chain: ${JSON.stringify(
        simulation.value.err
      ).slice(0, 300)}`
    );
  }

  const owned = (rows: z.infer<typeof tokenBalanceRowsSchema>) =>
    rows
      .filter(
        (row) => row.owner === input.ownerAddress && row.mint === input.mint
      )
      .reduce((total, row) => total + BigInt(row.uiTokenAmount.amount), 0n);
  const tokenDelta =
    owned(simulation.value.postTokenBalances ?? []) -
    owned(simulation.value.preTokenBalances ?? []);

  const satisfied =
    input.tolerance === "exact"
      ? tokenDelta === input.atoms
      : tokenDelta >= input.atoms;
  if (!satisfied) {
    throw new Error(
      `SDP returned a transaction that moves ${tokenDelta} atoms of the savings token instead of ${
        input.tolerance === "exact" ? "exactly" : "at least"
      } ${input.atoms}`
    );
  }

  const solDelta = (accountIndex: number): bigint | undefined => {
    const before = simulation.value.preBalances?.[accountIndex];
    const after = simulation.value.postBalances?.[accountIndex];
    return before === undefined || after === undefined
      ? undefined
      : BigInt(after) - BigInt(before);
  };

  // Signers are always static accounts: the fee payer at slot zero, then the
  // owner — the signer-set check above guarantees there is nothing else.
  const numSigners = Object.keys(
    getTransactionDecoder().decode(
      Buffer.from(signedTransactionBase64, "base64")
    ).signatures
  ).length;
  const ownerIndex = numSigners - 1;
  for (const accountIndex of new Set([0, ownerIndex])) {
    const delta = solDelta(accountIndex);
    if (delta === undefined) continue;
    if (delta < -MAX_FEE_AND_RENT_LAMPORTS) {
      throw new Error(
        `SDP returned a transaction that spends ${-delta} lamports from a signer's wallet, past the fee-and-rent ceiling`
      );
    }
  }
}

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
  if (!response.ok)
    throw new Error(`Solana RPC request failed with ${response.status}`);

  const envelope = rpcEnvelopeSchema.parse(await response.json());
  if (envelope.error) throw new Error(`Solana RPC: ${envelope.error.message}`);
  return envelope.result;
}
