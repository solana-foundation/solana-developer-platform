import type { Address } from "@solana/kit";
import { formatDecimalAmount } from "@/lib/amount";
import { badRequest } from "@/lib/errors";
import { assertValidAddress } from "@/lib/solana";
import { SOL_MINT } from "@/services/payment-operation.service";
import { type createRpc, getAccountInfo } from "@/services/solana/rpc";

export { SOL_MINT } from "@/services/payment-operation.service";

// biome-ignore lint/security/noSecrets: Devnet USDC mint address constant, not a secret.
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
// biome-ignore lint/security/noSecrets: Mainnet USDC mint address constant, not a secret.
const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// biome-ignore lint/security/noSecrets: Solana SPL Token program ID, not a secret.
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
// biome-ignore lint/security/noSecrets: Solana Token-2022 program ID, not a secret.
const SPL_TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const SPL_TOKEN_PROGRAM_IDS = [SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID] as const;
const KNOWN_TOKEN_LABELS_BY_MINT = new Map<string, string>([
  [SOL_MINT, "SOL"],
  [DEVNET_USDC_MINT, "USDC"],
  [MAINNET_USDC_MINT, "USDC"],
]);

function resolveTokenLabel(mint: string): string {
  return KNOWN_TOKEN_LABELS_BY_MINT.get(mint) ?? mint;
}

type JsonParsedTokenAccountEntry = {
  pubkey?: string;
  account?: {
    data?: {
      parsed?: {
        info?: unknown;
      };
    };
  };
};

type JsonParsedTokenAccountsByOwnerResponse = {
  value?: JsonParsedTokenAccountEntry[];
};

type TokenAccountsByOwnerRpc = {
  getTokenAccountsByOwner: (
    address: Address,
    filter: { programId: Address },
    config: { encoding: "jsonParsed"; commitment: "confirmed" }
  ) => {
    send: () => Promise<JsonParsedTokenAccountsByOwnerResponse>;
  };
};

type TokenSupplyRpc = {
  getTokenSupply: (
    mint: Address,
    config: { commitment: "confirmed" }
  ) => {
    send: () => Promise<{ value?: { decimals?: number } }>;
  };
};

async function getTokenAccountsByOwnerJsonParsed(
  rpc: ReturnType<typeof createRpc>,
  owner: Address,
  programId: Address
): Promise<JsonParsedTokenAccountsByOwnerResponse> {
  return (rpc as unknown as TokenAccountsByOwnerRpc)
    .getTokenAccountsByOwner(
      owner,
      { programId },
      { encoding: "jsonParsed", commitment: "confirmed" }
    )
    .send();
}

export async function resolveMintDecimals(
  rpc: ReturnType<typeof createRpc>,
  mint: Address
): Promise<number> {
  const response = await (rpc as unknown as TokenSupplyRpc)
    .getTokenSupply(mint, { commitment: "confirmed" })
    .send();
  const decimals = response.value?.decimals;

  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) {
    throw badRequest("Token mint decimals could not be resolved");
  }

  return decimals;
}

function parseTokenAmountInfo(
  value: unknown
): { mint: string; amount: bigint; decimals: number; uiAmount?: string } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const info = value as Record<string, unknown>;
  const mint = typeof info.mint === "string" ? info.mint : null;
  if (!mint) {
    return null;
  }

  const tokenAmount =
    typeof info.tokenAmount === "object" && info.tokenAmount !== null
      ? (info.tokenAmount as Record<string, unknown>)
      : null;
  if (!tokenAmount) {
    return null;
  }

  const rawAmount = tokenAmount.amount;
  const rawDecimals = tokenAmount.decimals;

  if (
    (typeof rawAmount !== "string" && typeof rawAmount !== "number") ||
    typeof rawDecimals !== "number"
  ) {
    return null;
  }

  let amount: bigint;
  try {
    amount = BigInt(String(rawAmount));
  } catch {
    return null;
  }

  const decimals = Number(rawDecimals);
  if (!Number.isInteger(decimals) || decimals < 0) {
    return null;
  }

  const uiAmount =
    typeof tokenAmount.uiAmountString === "string" ? tokenAmount.uiAmountString : undefined;

  return { mint, amount, decimals, uiAmount };
}

export async function getSplTokenBalances(
  rpc: ReturnType<typeof createRpc>,
  owner: Address
): Promise<
  Array<{ token: string; mint: string; amount: string; uiAmount: string; decimals: number }>
> {
  const balancesByMint = new Map<string, { amount: bigint; decimals: number; uiAmount?: string }>();

  for (const programId of SPL_TOKEN_PROGRAM_IDS) {
    const response = await getTokenAccountsByOwnerJsonParsed(rpc, owner, programId);

    for (const account of response.value ?? []) {
      const parsed = parseTokenAmountInfo(account.account?.data?.parsed?.info);
      if (!parsed || parsed.amount <= 0n) {
        continue;
      }

      const existing = balancesByMint.get(parsed.mint);
      if (existing) {
        existing.amount += parsed.amount;
        continue;
      }

      balancesByMint.set(parsed.mint, {
        amount: parsed.amount,
        decimals: parsed.decimals,
        uiAmount: parsed.uiAmount,
      });
    }
  }

  return Array.from(balancesByMint.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mint, balance]) => ({
      token: resolveTokenLabel(mint),
      mint,
      amount: balance.amount.toString(),
      uiAmount: balance.uiAmount ?? formatDecimalAmount(balance.amount, balance.decimals),
      decimals: balance.decimals,
    }));
}

export async function getSplTokenAccountAddresses(
  rpc: ReturnType<typeof createRpc>,
  owner: Address
): Promise<Address[]> {
  const addresses: Address[] = [];
  const seen = new Set<string>();
  const responses = await Promise.all(
    SPL_TOKEN_PROGRAM_IDS.map((programId) =>
      getTokenAccountsByOwnerJsonParsed(rpc, owner, programId)
    )
  );

  for (const response of responses) {
    for (const account of response.value ?? []) {
      if (typeof account.pubkey !== "string" || seen.has(account.pubkey)) {
        continue;
      }

      const tokenAccount = assertValidAddress(account.pubkey, "tokenAccount");
      seen.add(tokenAccount);
      addresses.push(tokenAccount);
    }
  }

  return addresses;
}

function assertSupportedTokenProgram(program: string): Address {
  if (program === SPL_TOKEN_PROGRAM_ID || program === SPL_TOKEN_2022_PROGRAM_ID) {
    return program as Address;
  }
  throw badRequest("Unsupported token program for mint");
}

export async function resolveMintTokenProgram(
  rpc: ReturnType<typeof createRpc>,
  mint: Address
): Promise<Address> {
  const mintAccountInfo = await getAccountInfo(rpc, mint);
  if (!mintAccountInfo) {
    throw badRequest("Token mint account does not exist");
  }
  return assertSupportedTokenProgram(mintAccountInfo.owner);
}

export async function resolveSourceTokenAccount(
  rpc: ReturnType<typeof createRpc>,
  owner: Address,
  mint: Address,
  tokenProgram: Address
): Promise<{ tokenAccount: Address; decimals: number }> {
  const response = await getTokenAccountsByOwnerJsonParsed(rpc, owner, tokenProgram);
  let selected: { tokenAccount: Address; decimals: number; amount: bigint } | null = null;

  for (const account of response.value ?? []) {
    if (typeof account.pubkey !== "string") {
      continue;
    }

    const parsed = parseTokenAmountInfo(account.account?.data?.parsed?.info);
    if (!parsed || parsed.mint !== mint) {
      continue;
    }

    const tokenAccount = assertValidAddress(account.pubkey, "sourceToken");
    if (!selected || parsed.amount > selected.amount) {
      selected = {
        tokenAccount,
        decimals: parsed.decimals,
        amount: parsed.amount,
      };
    }
  }

  if (!selected) {
    throw badRequest("Source wallet has no token account for this mint");
  }

  return {
    tokenAccount: selected.tokenAccount,
    decimals: selected.decimals,
  };
}
