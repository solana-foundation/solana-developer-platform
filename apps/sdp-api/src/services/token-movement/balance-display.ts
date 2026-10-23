import { createClusterRpc } from "@sdp/rpc/factory";
/**
 * Balances in their three units (ADR 0012): base units summed per mint, the
 * exact token amount, and the display value a wallet shows.
 *
 * Display comes from the SUMMED base units through the mint's Token Terms,
 * never from the RPC: its `uiAmount` is one account's value, so a wallet with
 * several accounts of a mint showed the first one only. A classic SPL mint has
 * no display extension, so it shows its token amount and needs no read.
 *
 * RPC budget per balance request: no extra request when every held mint is
 * native SOL or classic SPL; otherwise one `getMultipleAccounts` for the Clock
 * and every Token-2022 mint held across all the request's wallets (99 mints
 * per request, pages in parallel). Nothing is cached: an interest-bearing
 * mint's display changes every second.
 */

import { AmountError } from "@sdp/solana/amount";
import type { TokenAsset } from "@sdp/solana/asset-ref";
import { fetchTokenTermsOfMints } from "@sdp/solana/read-token-terms";
import { parseBaseUnits, toTokenAmount } from "@sdp/solana/token-amount";
import { type MintTokenTerms, TokenTermsError, toDisplay } from "@sdp/solana/token-terms";
import type { CustodyWalletBalance, CustodyWalletTokenBalance } from "@sdp/types/custody";
import { SOL_DECIMALS, SOL_MINT, type TokenProgramKind } from "@sdp/types/well-known-tokens";
import { address } from "@solana/kit";
import { getLogger } from "@/runtime/logger";
import { chainTimeIso } from "./chain-time";

/** One mint's holding before display: base units summed over the owner's accounts. */
export interface HeldTokenBalance {
  token: string;
  mint: string;
  /** Base units, summed over every account of the mint. */
  amount: string;
  decimals: number;
  /** The token program the accounts are under; null for native SOL. */
  program: TokenProgramKind | null;
}

/** The exact token amount of a base-unit string. */
function tokenAmountOf(amount: string, decimals: number): string {
  return toTokenAmount(parseBaseUnits(amount), decimals).value;
}

/** A holding whose display is its token amount: native SOL and classic SPL mints. */
function plainBalance(holding: HeldTokenBalance): CustodyWalletTokenBalance {
  const tokenAmount = tokenAmountOf(holding.amount, holding.decimals);
  return {
    token: holding.token,
    mint: holding.mint,
    amount: holding.amount,
    tokenAmount,
    displayAmount: tokenAmount,
    displayAsOf: null,
    displayRule: "plain",
    decimals: holding.decimals,
  };
}

/** A Token-2022 holding shown under its mint's terms. */
function displayedBalance(
  holding: HeldTokenBalance,
  terms: MintTokenTerms
): CustodyWalletTokenBalance {
  if (terms.display.kind === "plain") {
    return plainBalance(holding);
  }
  const tokenAmount = tokenAmountOf(holding.amount, holding.decimals);
  const display = toDisplay(terms, parseBaseUnits(holding.amount), terms.readAt.unixTimestamp);
  return {
    token: holding.token,
    mint: holding.mint,
    amount: holding.amount,
    tokenAmount,
    displayAmount: display.value,
    displayAsOf: chainTimeIso(terms.readAt.unixTimestamp),
    displayRule: terms.display.kind,
    decimals: holding.decimals,
  };
}

/** The native SOL holding of `lamports`, before display. */
export function nativeSolHolding(lamports: bigint): HeldTokenBalance {
  return {
    token: "SOL",
    mint: SOL_MINT,
    amount: lamports.toString(),
    decimals: SOL_DECIMALS,
    program: null,
  };
}

/** A wallet's native SOL balance: shown as its token amount. */
export function nativeSolBalance(lamports: bigint): CustodyWalletBalance {
  const tokenAmount = tokenAmountOf(lamports.toString(), SOL_DECIMALS);
  return {
    token: "SOL",
    mint: SOL_MINT,
    amount: lamports.toString(),
    tokenAmount,
    displayAmount: tokenAmount,
    displayAsOf: null,
    displayRule: "plain",
    decimals: SOL_DECIMALS,
  };
}

/**
 * The holdings of several wallets summed per asset, in base units, before
 * display: an aggregate shows the display of the sum, never a sum of
 * displays, so one token never shows two numbers. Native SOL and wrapped SOL
 * share a mint address but stay apart, as each wallet lists them. An asset
 * keeps the first wallet's label. Sorted by label, descending, as the
 * aggregate lists them.
 */
export function sumHoldings(sets: readonly (readonly HeldTokenBalance[])[]): HeldTokenBalance[] {
  const byAsset = new Map<string, HeldTokenBalance & { units: bigint }>();
  for (const holding of sets.flat()) {
    const key = `${holding.program === null ? "native" : holding.program}:${holding.mint}`;
    const units = parseBaseUnits(holding.amount);
    const current = byAsset.get(key);
    if (current === undefined) {
      byAsset.set(key, { ...holding, units });
    } else {
      current.units += units;
    }
  }
  return [...byAsset.values()]
    .map(({ units, ...holding }) => ({ ...holding, amount: units.toString() }))
    .sort((left, right) => right.token.localeCompare(left.token));
}

/**
 * The balance read a display follows: the caller's deadline (undefined for
 * none), and the slot the holdings were read at or after (undefined when the
 * read named none), which the terms read must see too.
 */
export type BalanceRead = Readonly<{
  abortSignal: AbortSignal | undefined;
  minContextSlot: bigint | undefined;
}>;

/**
 * Each set of holdings with its display amounts, reading the terms of every
 * Token-2022 mint across all sets once.
 *
 * A Token-2022 holding whose terms cannot be read (the mint does not decode,
 * for example under an extension the pinned client does not know) or whose
 * display overflows the program's f64 math is left out and logged: SDP can
 * neither show nor move it, and anyone can send a wallet such a token, so it
 * must not fail the whole read.
 *
 * @param sets - Holdings by key (a wallet id, or one aggregate).
 * @param read - The read the holdings came from: its deadline, and the slot
 *   it was at, which the terms read must see too.
 * @returns The same keys, each holding with `tokenAmount` and its display.
 * @throws When the terms read itself fails.
 */
export async function withDisplayAmounts<K>(
  sets: ReadonlyMap<K, readonly HeldTokenBalance[]>,
  read: BalanceRead
): Promise<Map<K, CustodyWalletTokenBalance[]>> {
  const keys = [...sets.keys()];
  const displayed = await displaySets([...sets.values()], read);
  return new Map(keys.map((key, index) => [key, displayed[index]]));
}

/** {@link withDisplayAmounts} for one wallet or one aggregate. */
export async function withDisplayAmount(
  holdings: readonly HeldTokenBalance[],
  read: BalanceRead
): Promise<CustodyWalletTokenBalance[]> {
  const [displayed] = await displaySets([holdings], read);
  return displayed;
}

/** Each set displayed, in order, from one terms read for all of them. */
async function displaySets(
  sets: readonly (readonly HeldTokenBalance[])[],
  read: BalanceRead
): Promise<CustodyWalletTokenBalance[][]> {
  const token2022Mints = [
    ...new Set(
      sets
        .flat()
        .filter((holding) => holding.program === "token-2022")
        .map((holding) => holding.mint)
    ),
  ];
  const assets: TokenAsset[] = token2022Mints.map((mint) => ({
    kind: "token",
    mint: address(mint),
    program: "token-2022",
  }));
  const termsByMint = new Map<string, MintTokenTerms | TokenTermsError>();
  if (assets.length > 0) {
    const termsRead = await fetchTokenTermsOfMints(createClusterRpc(), assets, read);
    termsRead.forEach((terms, index) => {
      termsByMint.set(token2022Mints[index], terms);
    });
  }

  const displayed = (holding: HeldTokenBalance): CustodyWalletTokenBalance[] => {
    if (holding.program !== "token-2022") {
      return [plainBalance(holding)];
    }
    const terms = termsByMint.get(holding.mint);
    if (terms === undefined) {
      throw new Error(`No terms were read for the Token-2022 mint ${holding.mint}`);
    }
    if (terms instanceof TokenTermsError) {
      getLogger().warn(
        { mint: holding.mint, reason: terms.reason, error: terms.message },
        "balance display: left out a holding whose mint terms cannot be read"
      );
      return [];
    }
    try {
      return [displayedBalance(holding, terms)];
    } catch (error) {
      if (!(error instanceof AmountError)) {
        throw error;
      }
      getLogger().warn(
        { mint: holding.mint, error: error.message },
        "balance display: left out a holding whose display overflows"
      );
      return [];
    }
  };

  return sets.map((holdings) => holdings.flatMap(displayed));
}
