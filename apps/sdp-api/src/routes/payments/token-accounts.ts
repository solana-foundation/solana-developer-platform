import { createClusterRpc } from "@sdp/rpc/factory";
import type { RpcParsedTokenAccount, SolanaRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import {
  SPL_TOKEN_PROGRAMS,
  TOKEN_PROGRAM_KINDS,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types/well-known-tokens";
import { type Address, address } from "@solana/kit";
import { badRequest } from "@/lib/errors";
import type { HeldTokenBalance } from "@/services/token-movement/balance-display";

const SPL_TOKEN_PROGRAM_ID = address(SPL_TOKEN_PROGRAMS["spl-token"]);
const SPL_TOKEN_2022_PROGRAM_ID = address(SPL_TOKEN_PROGRAMS["token-2022"]);
const SPL_TOKEN_PROGRAM_IDS = [SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID] as const;

export type TokenLabelsByMint = ReadonlyMap<string, string>;

interface GetSplTokenBalancesOptions {
  tokenLabelsByMint?: TokenLabelsByMint;
  /** Refuse answers from chain state older than this slot (the node errors instead). */
  minContextSlot?: bigint;
  abortSignal?: AbortSignal;
}

/** The token account an SPL transfer sends from: the owner's largest one for the mint. */
export interface SourceTokenAccount {
  tokenAccount: Address;
  decimals: number;
  /** Base units it held when read. */
  amount: bigint;
  frozen: boolean;
}

function issuedTokenLabel(mint: string, tokenLabelsByMint?: TokenLabelsByMint): string | null {
  return tokenLabelsByMint?.get(mint)?.trim() || null;
}

export function resolveTokenLabel(mint: string, tokenLabelsByMint?: TokenLabelsByMint): string {
  const issuedLabel = issuedTokenLabel(mint, tokenLabelsByMint);
  if (issuedLabel) return issuedLabel;
  const wellKnownToken = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
  return wellKnownToken ? wellKnownToken.symbol : mint;
}

/**
 * Renames each balance to the label the organization issued its mint under, where it
 * did. For balances read without labels, so the read can start before the labels are
 * known and be shared across callers whose labels differ.
 */
export function withIssuedTokenLabels<T extends { mint: string; token: string }>(
  balances: readonly T[],
  tokenLabelsByMint: TokenLabelsByMint
): T[] {
  return balances.map((balance) => {
    const issuedLabel = issuedTokenLabel(balance.mint, tokenLabelsByMint);
    return issuedLabel ? { ...balance, token: issuedLabel } : balance;
  });
}

function parseTokenAmountInfo(info: RpcParsedTokenAccount): {
  mint: Address;
  amount: bigint;
  decimals: number;
} {
  return {
    mint: info.mint,
    amount: BigInt(info.tokenAmount.amount),
    decimals: info.tokenAmount.decimals,
  };
}

/**
 * An owner's SPL holdings: base units summed per mint over every account,
 * under both token programs, with the program each mint's accounts are
 * under. Display is added by `withDisplayAmounts`, which reads Token-2022
 * terms; this read never takes the RPC's display values.
 *
 * RPC budget: one `getTokenAccountsByOwner` per token program, in parallel.
 */
export async function getSplTokenBalances(
  rpc: SolanaRpc,
  owner: Address,
  options?: GetSplTokenBalancesOptions
): Promise<HeldTokenBalance[]> {
  const balancesByMint = new Map<
    string,
    { amount: bigint; decimals: number; program: HeldTokenBalance["program"] }
  >();
  // One read per token program, independent of each other, so neither waits.
  const responses = await Promise.all(
    TOKEN_PROGRAM_KINDS.map(async (program) => ({
      program,
      response: await rpc
        .getTokenAccountsByOwner(
          owner,
          { programId: address(SPL_TOKEN_PROGRAMS[program]) },
          {
            encoding: "jsonParsed",
            commitment: "confirmed",
            minContextSlot: options?.minContextSlot,
          }
        )
        .send({ abortSignal: options?.abortSignal }),
    }))
  );

  for (const { program, response } of responses) {
    for (const account of response.value) {
      const parsed = parseTokenAmountInfo(account.account.data.parsed.info);
      if (parsed.amount <= 0n) {
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
        program,
      });
    }
  }

  return Array.from(balancesByMint.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mint, balance]) => ({
      token: resolveTokenLabel(mint, options?.tokenLabelsByMint),
      mint,
      amount: balance.amount.toString(),
      decimals: balance.decimals,
      program: balance.program,
    }));
}

export async function getSplTokenAccountAddresses(
  rpc: SolanaRpc,
  owner: Address
): Promise<Address[]> {
  const addresses: Address[] = [];
  const seen = new Set<string>();
  const responses = await Promise.all(
    SPL_TOKEN_PROGRAM_IDS.map((programId) =>
      rpc
        .getTokenAccountsByOwner(
          owner,
          { programId },
          { encoding: "jsonParsed", commitment: "confirmed" }
        )
        .send()
    )
  );

  for (const response of responses) {
    for (const account of response.value) {
      if (seen.has(account.pubkey)) {
        continue;
      }

      const tokenAccount = assertValidAddress(account.pubkey, "tokenAccount");
      seen.add(tokenAccount);
      addresses.push(tokenAccount);
    }
  }

  return addresses;
}

export async function resolveSourceTokenAccount(
  owner: Address,
  mint: Address,
  tokenProgram: Address
): Promise<SourceTokenAccount> {
  const selected = await findSourceTokenAccount(owner, mint, tokenProgram);

  if (!selected) {
    throw badRequest("Source wallet has no token account for this mint");
  }

  return selected;
}

async function findSourceTokenAccount(
  owner: Address,
  mint: Address,
  tokenProgram: Address
): Promise<SourceTokenAccount | null> {
  const response = await createClusterRpc()
    .getTokenAccountsByOwner(
      owner,
      { programId: tokenProgram },
      { encoding: "jsonParsed", commitment: "confirmed" }
    )
    .send();
  let selected: SourceTokenAccount | null = null;

  for (const account of response.value) {
    const parsed = parseTokenAmountInfo(account.account.data.parsed.info);
    if (parsed.mint !== mint) {
      continue;
    }

    const tokenAccount = assertValidAddress(account.pubkey, "sourceToken");
    if (selected === null || parsed.amount > selected.amount) {
      selected = {
        tokenAccount,
        decimals: parsed.decimals,
        amount: parsed.amount,
        frozen: account.account.data.parsed.info.state === "frozen",
      };
    }
  }

  return selected;
}
