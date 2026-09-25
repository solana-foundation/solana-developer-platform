import { type createRpc, getAccountInfo } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import {
  type Address,
  address,
  createNoopSigner,
  type JsonParsedTokenAccount,
  type TransactionSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import { badRequest } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";

export { SOL_MINT } from "@/services/payment-operation.service";

const SPL_TOKEN_PROGRAM_ID = address(SPL_TOKEN_PROGRAMS["spl-token"]);
const SPL_TOKEN_2022_PROGRAM_ID = address(SPL_TOKEN_PROGRAMS["token-2022"]);
const SPL_TOKEN_PROGRAM_IDS = [SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID] as const;

export type TokenLabelsByMint = ReadonlyMap<string, string>;

interface GetSplTokenBalancesOptions {
  tokenLabelsByMint?: TokenLabelsByMint;
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

export async function resolveMintDecimals(
  rpc: ReturnType<typeof createRpc>,
  mint: Address
): Promise<number> {
  const response = await rpc.getTokenSupply(mint, { commitment: "confirmed" }).send();
  const decimals = response.value.decimals;

  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) {
    throw badRequest("Token mint decimals could not be resolved");
  }

  return decimals;
}

function isValidSplDecimals(decimals: number): boolean {
  return typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0;
}

function parseTokenAmountInfo(info: JsonParsedTokenAccount): {
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

interface SplAccountRead {
  address: Address;
  amount: bigint;
  decimals: number;
}

/**
 * Settles one mint's decimals conflict the way the mint itself would. The
 * mint's own decimals are the scale its raw units are denominated in, so
 * accounts that match the mint are accepted and the rest are rejected; if the
 * mint's decimals cannot be resolved, no account has a confirmed scale and the
 * whole read fails rather than returning a successful balance read that
 * silently omits the mint's holdings.
 */
async function acceptReadsOnMintScale(
  rpc: ReturnType<typeof createRpc>,
  mint: string,
  reads: SplAccountRead[]
): Promise<SplAccountRead[]> {
  let mintDecimals: number;
  try {
    mintDecimals = await resolveMintDecimals(rpc, address(mint));
  } catch (error) {
    throw new Error(
      `getSplTokenBalances: could not settle the conflicting scales of ${reads.length} accounts for mint ${mint} against the mint's own decimals`,
      { cause: error }
    );
  }

  const accepted: SplAccountRead[] = [];
  for (const read of reads) {
    if (read.decimals === mintDecimals) {
      accepted.push(read);
      continue;
    }
    getLogger().warn(
      { tokenAccount: read.address, mint, decimals: read.decimals, mintDecimals },
      "getSplTokenBalances: rejected a same-mint token account with inconsistent decimals"
    );
  }
  return accepted;
}

export async function getSplTokenBalances(
  rpc: ReturnType<typeof createRpc>,
  owner: Address,
  options?: GetSplTokenBalancesOptions
): Promise<
  Array<{ token: string; mint: string; amount: string; uiAmount: string; decimals: number }>
> {
  // One read per token program, independent of each other, so neither waits.
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

  // Raw base units are the source of truth; the UI amount is recomputed from
  // the summed amount below. An account whose decimals are invalid is on an
  // incompatible scale, so its raw units are rejected rather than summed.
  const readsByMint = new Map<string, SplAccountRead[]>();
  for (const response of responses) {
    for (const account of response.value) {
      const parsed = parseTokenAmountInfo(account.account.data.parsed.info);
      if (parsed.amount <= 0n) {
        continue;
      }

      if (!isValidSplDecimals(parsed.decimals)) {
        getLogger().warn(
          { tokenAccount: account.pubkey, mint: parsed.mint, decimals: parsed.decimals },
          "getSplTokenBalances: rejected a token account with invalid decimals"
        );
        continue;
      }

      const sameMint = readsByMint.get(parsed.mint) ?? [];
      sameMint.push({ address: account.pubkey, amount: parsed.amount, decimals: parsed.decimals });
      readsByMint.set(parsed.mint, sameMint);
    }
  }

  const balances: Array<{
    token: string;
    mint: string;
    amount: string;
    uiAmount: string;
    decimals: number;
  }> = [];
  for (const [mint, mintReads] of readsByMint) {
    // Which account the RPC returned first must not decide the aggregation:
    // a mint whose accounts disagree on decimals is settled against the mint,
    // not against the account that happened to come back first.
    let accepted = mintReads;
    if (new Set(mintReads.map((read) => read.decimals)).size > 1) {
      accepted = await acceptReadsOnMintScale(rpc, mint, mintReads);
      if (accepted.length === 0) {
        continue;
      }
    }

    const amount = accepted.reduce((total, read) => total + read.amount, 0n);
    balances.push({
      token: resolveTokenLabel(mint, options?.tokenLabelsByMint),
      mint,
      amount: amount.toString(),
      uiAmount: formatDecimalAmount(amount, accepted[0].decimals),
      decimals: accepted[0].decimals,
    });
  }

  return balances.sort((a, b) => a.mint.localeCompare(b.mint));
}

export async function getSplTokenAccountAddresses(
  rpc: ReturnType<typeof createRpc>,
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

function assertSupportedTokenProgram(program: string): Address {
  if (program === SPL_TOKEN_PROGRAM_ID || program === SPL_TOKEN_2022_PROGRAM_ID) {
    return address(program);
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
  const selected = await findSourceTokenAccount(rpc, owner, mint, tokenProgram);

  if (!selected) {
    throw badRequest("Source wallet has no token account for this mint");
  }

  return {
    tokenAccount: selected.tokenAccount,
    decimals: selected.decimals,
  };
}

export async function resolveSourceTokenAccountOrAta(
  rpc: ReturnType<typeof createRpc>,
  owner: Address,
  mint: Address,
  tokenProgram: Address
): Promise<{ tokenAccount: Address; decimals: number; exists: boolean }> {
  const [tokenAccount] = await findAssociatedTokenPda({
    owner,
    tokenProgram,
    mint,
  });
  const [tokenAccountInfo, decimals] = await Promise.all([
    getAccountInfo(rpc, tokenAccount),
    resolveMintDecimals(rpc, mint),
  ]);

  return {
    tokenAccount,
    decimals,
    exists: tokenAccountInfo !== null,
  };
}

/**
 * Build the standard SPL transfer instruction pair: an idempotent ATA
 * creation for the destination (rent paid by `ataRentPayer`) followed by a
 * transferChecked from the authority's largest token account.
 */
export async function buildSplTransferInstructions(
  rpc: ReturnType<typeof createRpc>,
  input: {
    authority: TransactionSigner;
    destination: Address;
    mint: Address;
    amount: string;
    ataRentPayer: Address;
  }
) {
  const tokenProgram = await resolveMintTokenProgram(rpc, input.mint);
  const sourceTokenAccount = await resolveSourceTokenAccount(
    rpc,
    input.authority.address,
    input.mint,
    tokenProgram
  );
  const transferAmount = parseDecimalAmount(input.amount, sourceTokenAccount.decimals);
  if (transferAmount <= 0n) {
    throw badRequest("Transfer amount must be greater than zero");
  }

  const [destinationTokenAccount] = await findAssociatedTokenPda({
    owner: input.destination,
    tokenProgram,
    mint: input.mint,
  });

  return {
    createDestinationAtaInstruction: getCreateAssociatedTokenIdempotentInstruction({
      payer: createNoopSigner(input.ataRentPayer),
      ata: destinationTokenAccount,
      owner: input.destination,
      mint: input.mint,
      tokenProgram,
    }),
    transferInstruction: getTransferCheckedInstruction(
      {
        source: sourceTokenAccount.tokenAccount,
        mint: input.mint,
        destination: destinationTokenAccount,
        authority: input.authority,
        amount: transferAmount,
        decimals: sourceTokenAccount.decimals,
      },
      { programAddress: tokenProgram }
    ),
  };
}

async function findSourceTokenAccount(
  rpc: ReturnType<typeof createRpc>,
  owner: Address,
  mint: Address,
  tokenProgram: Address
): Promise<{ tokenAccount: Address; decimals: number; amount: bigint } | null> {
  const response = await rpc
    .getTokenAccountsByOwner(
      owner,
      { programId: tokenProgram },
      { encoding: "jsonParsed", commitment: "confirmed" }
    )
    .send();
  let selected: { tokenAccount: Address; decimals: number; amount: bigint } | null = null;

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
      };
    }
  }

  return selected;
}
