import { type createRpc, getAccountInfo } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { parseDecimalAmount } from "@sdp/solana/amount";
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

export { SOL_MINT } from "@/services/payment-operation.service";

const SPL_TOKEN_PROGRAM_ID = address(SPL_TOKEN_PROGRAMS["spl-token"]);
const SPL_TOKEN_2022_PROGRAM_ID = address(SPL_TOKEN_PROGRAMS["token-2022"]);
const SPL_TOKEN_PROGRAM_IDS = [SPL_TOKEN_PROGRAM_ID, SPL_TOKEN_2022_PROGRAM_ID] as const;

export type TokenLabelsByMint = ReadonlyMap<string, string>;

interface GetSplTokenBalancesOptions {
  tokenLabelsByMint?: TokenLabelsByMint;
}

export function resolveTokenLabel(mint: string, tokenLabelsByMint?: TokenLabelsByMint): string {
  const issuedLabel = tokenLabelsByMint?.get(mint)?.trim();
  if (issuedLabel) return issuedLabel;
  const wellKnownToken = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
  return wellKnownToken ? wellKnownToken.symbol : mint;
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
  rpc: ReturnType<typeof createRpc>,
  owner: Address,
  options?: GetSplTokenBalancesOptions
): Promise<
  Array<{ token: string; mint: string; amount: string; uiAmount: string; decimals: number }>
> {
  const balancesByMint = new Map<string, { amount: bigint; decimals: number; uiAmount: string }>();

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
