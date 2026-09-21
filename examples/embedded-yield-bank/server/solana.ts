import "server-only";

import {
  getBase64EncodedWireTransaction,
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

export async function signTransaction(
  transactionBase64: string,
  signers: readonly KeyPairSigner[]
): Promise<string> {
  const transaction = getTransactionDecoder().decode(
    Buffer.from(transactionBase64, "base64")
  );
  const signed = await partiallySignTransaction(
    signers.map((signer) => signer.keyPair),
    transaction
  );
  return getBase64EncodedWireTransaction(signed);
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
