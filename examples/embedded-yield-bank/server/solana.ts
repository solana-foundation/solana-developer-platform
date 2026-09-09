import {
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
  partiallySignTransaction,
} from "@solana/kit";
import { z } from "zod";
import type { TokenBalance, YieldStrategy } from "../src/types.ts";
import { formatAtoms } from "./decimal.ts";

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

const balanceSchema = z.object({ value: z.number().int().nonnegative() });

const DEVNET_SYMBOLS: Record<string, string> = {
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": "USDC",
};

export async function signTransaction(
  transactionBase64: string,
  signer: KeyPairSigner
): Promise<string> {
  const transaction = getTransactionDecoder().decode(
    Buffer.from(transactionBase64, "base64")
  );
  const signed = await partiallySignTransaction([signer.keyPair], transaction);
  return getBase64EncodedWireTransaction(signed);
}

export async function readWalletBalances(
  rpcUrl: string,
  ownerAddress: string,
  strategies: readonly YieldStrategy[]
): Promise<{ solBalance: string; tokens: TokenBalance[] }> {
  const mints = [
    ...new Set(
      strategies
        .filter(
          (strategy) => strategy.fundable && strategy.hostCluster === "devnet"
        )
        .flatMap((strategy) => strategy.depositMints)
    ),
  ];

  const [lamports, tokenBalances] = await Promise.all([
    rpcCall(rpcUrl, "getBalance", [
      ownerAddress,
      { commitment: "confirmed" },
    ]).then((result) => balanceSchema.parse(result)),
    Promise.all(
      mints.map((mint) => readTokenBalance(rpcUrl, ownerAddress, mint))
    ),
  ]);

  return {
    solBalance: formatAtoms(BigInt(lamports.value), 9),
    tokens: tokenBalances,
  };
}

async function readTokenBalance(
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
    symbol: DEVNET_SYMBOLS[mint] ?? `Token ${mint.slice(0, 4)}`,
    amount: formatAtoms(atoms, decimals),
    decimals,
  };
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
