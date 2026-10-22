import { createClusterRpc } from "@sdp/rpc/factory";
import { getAccountInfo, type SolanaRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
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
import {
  loadPaymentMint,
  type PaymentAmountConverter,
  type PaymentMint,
} from "@/services/payments/token-amount";

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

/** A source token account with its mint's token program, read once for a send to reuse. */
export interface SplTransferSource extends SourceTokenAccount {
  tokenProgram: Address;
  /** The funding check's converter; the build reuses it so both see one raw amount. */
  toBaseUnits: PaymentAmountConverter;
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

function parseTokenAmountInfo(info: JsonParsedTokenAccount): {
  mint: Address;
  amount: bigint;
  decimals: number;
  uiAmount: string;
} {
  return {
    mint: info.mint,
    amount: BigInt(info.tokenAmount.amount),
    decimals: info.tokenAmount.decimals,
    uiAmount: info.tokenAmount.uiAmountString,
  };
}

export async function getSplTokenBalances(
  rpc: SolanaRpc,
  owner: Address,
  options?: GetSplTokenBalancesOptions
): Promise<
  Array<{ token: string; mint: string; amount: string; uiAmount: string; decimals: number }>
> {
  const balancesByMint = new Map<string, { amount: bigint; decimals: number; uiAmount: string }>();
  // One read per token program, independent of each other, so neither waits.
  const responses = await Promise.all(
    SPL_TOKEN_PROGRAM_IDS.map((programId) =>
      rpc
        .getTokenAccountsByOwner(
          owner,
          { programId },
          {
            encoding: "jsonParsed",
            commitment: "confirmed",
            minContextSlot: options?.minContextSlot,
          }
        )
        .send({ abortSignal: options?.abortSignal })
    )
  );

  for (const response of responses) {
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
        uiAmount: parsed.uiAmount,
      });
    }
  }

  return Array.from(balancesByMint.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mint, balance]) => ({
      token: resolveTokenLabel(mint, options?.tokenLabelsByMint),
      mint,
      amount: balance.amount.toString(),
      uiAmount: balance.uiAmount,
      decimals: balance.decimals,
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

export async function resolveSourceTokenAccountOrAta(
  owner: Address,
  mint: Address,
  paymentMint: PaymentMint
): Promise<{ tokenAccount: Address; decimals: number; exists: boolean }> {
  const [tokenAccount] = await findAssociatedTokenPda({
    owner,
    tokenProgram: paymentMint.tokenProgram,
    mint,
  });
  const tokenAccountInfo = await getAccountInfo(createClusterRpc(), tokenAccount);

  return {
    tokenAccount,
    decimals: paymentMint.decimals,
    exists: tokenAccountInfo !== null,
  };
}

/**
 * Build the standard SPL transfer instruction pair: an idempotent ATA
 * creation for the destination (rent paid by `ataRentPayer`) followed by a
 * transferChecked from the authority's largest token account.
 */
export async function buildSplTransferInstructions(input: {
  authority: TransactionSigner;
  destination: Address;
  mint: Address;
  amount: string;
  ataRentPayer: Address;
  /** The source this request already read, so the build reads nothing again. */
  source?: SplTransferSource;
}) {
  let source = input.source;
  if (source === undefined) {
    const mint = await loadPaymentMint(input.mint);
    const account = await resolveSourceTokenAccount(
      input.authority.address,
      input.mint,
      mint.tokenProgram
    );
    source = { ...account, ...mint };
  }
  const { tokenProgram } = source;
  const sourceTokenAccount = source;
  const transferAmount = source.toBaseUnits(input.amount);
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
