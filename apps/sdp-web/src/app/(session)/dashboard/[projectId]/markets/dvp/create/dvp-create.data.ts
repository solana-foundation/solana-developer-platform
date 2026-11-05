"use client";

import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import { useMemo } from "react";
import { z } from "zod";
import { dvpQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/dvp/dvp-query-key";
import {
  type IssuedTokenSymbol,
  useIssuedTokens,
  useWalletSummaries,
} from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";
import { useDashboardKeyScope, useDashboardRead } from "@/lib/dashboard-swr";

/**
 * What the create form needs to offer real choices instead of blank fields.
 *
 * The asset leg is tied to the organization's own issued tokens, so the common
 * case is picking a token you already made rather than pasting a mint address
 * you have to go and look up.
 */

export interface DvpCreateOption {
  /** The mint address, which is what the API actually takes. */
  mint: string;
  label: string;
  /** The token's human name ("USD Coin"), or null when the metadata has none. */
  name: string | null;
  /**
   * Lets the form take a human amount and convert it. Null when unknown, in
   * which case the field falls back to base units rather than guessing a scale
   * and moving the wrong quantity.
   */
  decimals: number | null;
  /**
   * The program that owns the mint. Not assumable: USDC and USDT are legacy
   * SPL Token, and declaring them as Token-2022 makes create refuse an
   * otherwise valid trade, because the escrow address derives from this.
   */
  tokenProgram: string;
}

/** Wallet choices are derived from the validated custody response. */
export interface DvpCreateWallet {
  id: string;
  label: string | null;
  custodyConfigId?: string;
  custodyConnectionId?: string;
  isRuntimeExecutionAllowed: boolean;
  address: string;
  /**
   * What this wallet holds, or null when balances were not loaded. The page
   * does not wait on them: reading every wallet's balances took seconds and
   * nothing on the form renders one (PRO-1851). Null is never read as zero.
   */
  balances: DvpWalletBalance[] | null;
}

/** One token balance, as much of it as the amount field needs. */
export interface DvpWalletBalance {
  mint: string;
  /** Base units, the same convention the amount converts to. */
  amount: string;
  decimals: number;
  symbol: string | null;
}

/**
 * A registered counterparty crypto-wallet account, as a party slot option.
 *
 * The API resolves `counterpartyAccountId` to the account's address at create
 * and stores the reference; the client carries the address only to compare the
 * two slots and to label payouts.
 */
export interface DvpCreateCounterpartyAccount {
  counterpartyAccountId: string;
  /** Who the account belongs to, as the picker should name it. */
  name: string;
  label: string | null;
  address: string;
}

export interface DvpCreateContext {
  wallets: DvpCreateWallet[];
  tokens: DvpCreateOption[];
  counterpartyAccounts: DvpCreateCounterpartyAccount[];
  error: string | null;
}

/** A deployment without Issuance has no issued tokens to offer, and the listing is never read. */
const NO_ISSUED_TOKENS: readonly IssuedTokenSymbol[] = [];

const counterpartyAccountRowSchema = z.object({
  counterpartyAccountId: z.string().optional(),
  /** `counterparty_display_name` — the picker's label, always present. */
  name: z.string().optional(),
  label: z.string().nullable().optional(),
  address: z.string().optional(),
});

type CounterpartyAccountRow = z.infer<typeof counterpartyAccountRowSchema>;

const counterpartyAccountsResponseSchema = z.object({
  data: z.object({ accounts: z.array(counterpartyAccountRowSchema) }),
});

function mapCounterpartyAccounts(rows: readonly CounterpartyAccountRow[]) {
  return rows.flatMap((account) =>
    account.counterpartyAccountId && account.name && account.address
      ? [
          {
            counterpartyAccountId: account.counterpartyAccountId,
            name: account.name,
            label: account.label ?? null,
            address: account.address,
          },
        ]
      : []
  );
}

/**
 * The create form's options, or `undefined` while any read is in flight. A failed read never reads
 * as "you have none": a token list that failed would send someone hunting for assets they can see
 * in Issuance, and a counterparty list that failed would hide the second-reference option from
 * somebody who uses it daily. Each failure keeps the options read before it and names itself.
 *
 * Wallets are read without balances: a chain read per wallet held the whole form back by five to
 * seven seconds, and no field shows one. Funding still refuses a short balance with the amount
 * named.
 */
export function useDvpCreateContext(issuanceEnabled: boolean) {
  const scope = useDashboardKeyScope();
  const walletsRead = useWalletSummaries({ includeBalances: false });
  const tokensRead = useIssuedTokens(issuanceEnabled);
  const accountsRead = useDashboardRead(
    dvpQueryKeys.createCounterpartyAccounts(scope),
    counterpartyAccountsResponseSchema
  );
  const wallets = walletsRead.data;
  const walletsError = walletsRead.error;
  const tokenRows = issuanceEnabled ? tokensRead.data : NO_ISSUED_TOKENS;
  const tokensError = tokensRead.error;
  const accountRows = accountsRead.data;
  const accountsError = accountsRead.error;
  const retry = () => {
    if (walletsError !== undefined) void walletsRead.mutate();
    if (tokensError !== undefined) void tokensRead.mutate();
    if (accountsError !== undefined) void accountsRead.mutate();
  };
  const context = useMemo((): DvpCreateContext | undefined => {
    if (
      (wallets === undefined && walletsError === undefined) ||
      (tokenRows === undefined && tokensError === undefined) ||
      (accountRows === undefined && accountsError === undefined)
    ) {
      return undefined;
    }
    if (wallets === undefined) {
      return {
        wallets: [],
        tokens: [],
        counterpartyAccounts: [],
        error: walletsError?.message || "Wallet list failed.",
      };
    }
    const walletOptions: DvpCreateWallet[] = wallets.map((wallet) => ({
      id: wallet.id,
      address: wallet.publicKey,
      label: wallet.label,
      custodyConfigId: wallet.custodyConfigId,
      custodyConnectionId: wallet.custodyConnectionId,
      isRuntimeExecutionAllowed: wallet.isRuntimeExecutionAllowed,
      // Read without balances, which is not "holds nothing".
      balances: null,
    }));
    if (tokenRows === undefined) {
      return {
        wallets: walletOptions,
        tokens: [],
        counterpartyAccounts: [],
        error: tokensError?.message || "Token list failed.",
      };
    }
    // Only deployed tokens have a mint to trade. A draft has nothing to put in escrow, so offering
    // it would be an invitation to a 400. Whether DvP will ACCEPT a mint is deliberately not
    // decided here: create reads the mint on chain and refuses with the offending extension named.
    const tokens = tokenRows.map(toTokenOption);
    if (accountRows === undefined) {
      return {
        wallets: walletOptions,
        tokens,
        counterpartyAccounts: [],
        error: accountsError?.message || "Counterparty list failed.",
      };
    }
    return {
      wallets: walletOptions,
      tokens,
      counterpartyAccounts: mapCounterpartyAccounts(accountRows.data.accounts),
      error: null,
    };
  }, [wallets, walletsError, tokenRows, tokensError, accountRows, accountsError]);
  return { context, retry };
}

/**
 * The Token-2022 program id, spelled once for the create flow: every
 * SDP-issued asset is minted under it, and a pasted mint with no known
 * program assumes it.
 */
export const TOKEN_2022_PROGRAM = SPL_TOKEN_PROGRAMS["token-2022"];

/**
 * The listing carries no token program and its `extensions` is an object about the permanent
 * delegate, NOT the Token-2022 extension set, so it cannot tell us whether DvP will accept a mint.
 */
function toTokenOption(token: IssuedTokenSymbol): DvpCreateOption {
  return {
    mint: token.mintAddress,
    label: token.symbol || token.name || token.mintAddress,
    name: token.name ? token.name : null,
    decimals: token.decimals,
    // Every SDP-issued asset is minted under Token-2022.
    tokenProgram: TOKEN_2022_PROGRAM,
  };
}
