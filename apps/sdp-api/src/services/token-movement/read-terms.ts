/**
 * Reads Token Terms from the chain (ADR 0012).
 *
 * RPC budget: one `getMultipleAccounts` request for the mint and the Clock
 * sysvar together, so the fee epoch and the display time belong to the slot
 * that held these mint bytes. A movement's destination token accounts ride
 * the same request, so their memo rule and existence cost no extra round
 * trip; past the request's 100 accounts, the rest are read in concurrent
 * pages. Native SOL makes no request.
 *
 * Nothing is cached. Every field moves value: a fee can rise, a hook can be
 * set, and a mint with a close authority can be closed and created again at
 * the same address with other decimals.
 */

import { createClusterRpc } from "@sdp/rpc/factory";
import type { AssetRequest } from "@sdp/solana/asset-ref";
import {
  type DestinationTokenAccount,
  decodeDestinationTokenAccount,
} from "@sdp/solana/token-movement";
import {
  decodeTokenTerms,
  type MintTokenTerms,
  NATIVE_TOKEN_TERMS,
  type TokenTerms,
  TokenTermsError,
} from "@sdp/solana/token-terms";
import {
  SPL_TOKEN_PROGRAMS,
  TOKEN_PROGRAM_KINDS,
  type TokenProgramKind,
} from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  assertAccountExists,
  fetchEncodedAccounts,
  type MaybeEncodedAccount,
} from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { decodeToken, findAssociatedTokenPda } from "@solana-program/token-2022";
import { badRequest } from "@/lib/errors";

/** `getMultipleAccounts` takes at most this many addresses. */
const MAX_ACCOUNTS_PER_READ = 100;

/** A mint movement's terms and its destinations' token accounts, read together. */
export interface MintMovementAccounts {
  terms: MintTokenTerms;
  /** Each destination owner's token account for the mint, in request order. */
  destinations: DestinationTokenAccount[];
}

/** One destination's candidate token accounts, one per program the mint may be under. */
interface DestinationCandidates {
  owner: Address;
  byProgram: ReadonlyMap<TokenProgramKind, Address>;
}

async function destinationCandidates(
  mint: Address,
  owner: Address,
  programs: readonly TokenProgramKind[]
): Promise<DestinationCandidates> {
  const entries = await Promise.all(
    programs.map(async (program): Promise<[TokenProgramKind, Address]> => {
      const [tokenAccount] = await findAssociatedTokenPda({
        owner,
        mint,
        tokenProgram: address(SPL_TOKEN_PROGRAMS[program]),
      });
      return [program, tokenAccount];
    })
  );
  return { owner, byProgram: new Map(entries) };
}

/** Reads `addresses` in pages of at most 100, all pages at once, in order. */
async function readAccounts(addresses: readonly Address[]): Promise<MaybeEncodedAccount[]> {
  const rpc = createClusterRpc();
  const pages: Address[][] = [];
  for (let start = 0; start < addresses.length; start += MAX_ACCOUNTS_PER_READ) {
    pages.push(addresses.slice(start, start + MAX_ACCOUNTS_PER_READ));
  }
  const results = await Promise.all(
    pages.map((page) => fetchEncodedAccounts(rpc, page, { commitment: "confirmed" }))
  );
  return results.flat();
}

function decodeTerms(
  asset: Exclude<AssetRequest, { kind: "native" }>,
  mint: MaybeEncodedAccount,
  clock: MaybeEncodedAccount
): MintTokenTerms {
  if (!mint.exists) {
    throw badRequest("Token mint account does not exist");
  }
  // The Clock sysvar always exists; a node answering otherwise is not one to
  // price a movement by, so this fails like any failed read.
  assertAccountExists(clock);
  try {
    return decodeTokenTerms(asset, { mint, clock });
  } catch (cause) {
    if (cause instanceof TokenTermsError) {
      throw badRequest(cause.message);
    }
    throw cause;
  }
}

/**
 * The terms of the mint a movement names and its destinations' token
 * accounts, read live on the open cluster scope. A mint the catalogue does not
 * name could be under either token program, so both candidate accounts of each
 * destination are read, and the mint's owner picks one.
 *
 * @param asset - The resolved request asset.
 * @param destinationOwners - The wallets the movement pays.
 * @returns The mint's terms at the slot read and each owner's token account.
 * @throws AppError (400) when no account exists at the mint address, the
 * account is not a mint of a supported token program, its owner is not the
 * program the catalogue names, or it carries an extension state the program
 * refuses.
 */
export async function readMintMovementAccounts(
  asset: Exclude<AssetRequest, { kind: "native" }>,
  destinationOwners: readonly Address[]
): Promise<MintMovementAccounts> {
  const programs: readonly TokenProgramKind[] =
    asset.kind === "token" ? [asset.program] : TOKEN_PROGRAM_KINDS;
  const candidates = await Promise.all(
    destinationOwners.map((owner) => destinationCandidates(asset.mint, owner, programs))
  );
  // A batch may pay one owner twice; its account is read once.
  const candidateAddresses = new Set(
    candidates.flatMap((candidate) => [...candidate.byProgram.values()])
  );
  const [mint, clock, ...destinationAccounts] = await readAccounts([
    asset.mint,
    SYSVAR_CLOCK_ADDRESS,
    ...candidateAddresses,
  ]);
  const terms = decodeTerms(asset, mint, clock);

  const accountsByAddress = new Map(
    destinationAccounts.map((account) => [account.address, account])
  );
  const destinations = candidates.map((candidate) => {
    const tokenAccount = candidate.byProgram.get(terms.asset.program);
    const account = tokenAccount === undefined ? undefined : accountsByAddress.get(tokenAccount);
    if (tokenAccount === undefined || account === undefined) {
      throw new Error(`No ${terms.asset.program} token account was read for ${candidate.owner}`);
    }
    return decodeDestinationTokenAccount(terms, candidate.owner, tokenAccount, account);
  });
  return { terms, destinations };
}

/**
 * The terms of the asset a request names, read live on the open cluster
 * scope: static for native SOL, which makes no request; otherwise
 * {@link readMintMovementAccounts} with no destination.
 */
export async function readTokenTerms(asset: AssetRequest): Promise<TokenTerms> {
  if (asset.kind === "native") {
    return NATIVE_TOKEN_TERMS;
  }
  return (await readMintMovementAccounts(asset, [])).terms;
}

/**
 * The terms of the mint a movement names and the token account it pays, as the
 * caller names that account (not derived from an owner). An account that does
 * not exist yet, or holds only lamports, reads as missing.
 *
 * RPC budget: one `getMultipleAccounts` for the mint, the Clock and the account.
 *
 * @throws AppError (400) when the mint is unreadable (see
 * {@link readMintMovementAccounts}) or the account is not a token account of
 * the mint under the mint's program.
 */
export async function readMintMovementAccountAt(
  asset: Exclude<AssetRequest, { kind: "native" }>,
  tokenAccount: Address
): Promise<{ terms: MintTokenTerms; receiver: DestinationTokenAccount }> {
  const [mint, clock, account] = await readAccounts([
    asset.mint,
    SYSVAR_CLOCK_ADDRESS,
    tokenAccount,
  ]);
  const terms = decodeTerms(asset, mint, clock);
  if (account === undefined) {
    throw new Error(`No account was read for ${tokenAccount}`);
  }
  const unopened =
    !account.exists ||
    (account.programAddress === SYSTEM_PROGRAM_ADDRESS && account.data.length === 0);
  if (unopened) {
    return {
      terms,
      receiver: decodeDestinationTokenAccount(terms, tokenAccount, tokenAccount, account),
    };
  }
  const refusal = `${tokenAccount} is not a token account of this mint`;
  if (account.programAddress !== SPL_TOKEN_PROGRAMS[terms.asset.program]) {
    throw badRequest(refusal);
  }
  const { data } = decodeToken(account);
  if (data.mint !== terms.asset.mint) {
    throw badRequest(refusal);
  }
  return {
    terms,
    receiver: decodeDestinationTokenAccount(terms, data.owner, tokenAccount, account),
  };
}
