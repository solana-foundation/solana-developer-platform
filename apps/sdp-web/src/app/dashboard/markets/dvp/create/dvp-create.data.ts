import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { z } from "zod";
import type { SdpApiClient } from "@/lib/sdp-api";

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
export type DvpCreateWallet = Omit<z.infer<typeof walletRowSchema>, "publicKey" | "balances"> & {
  address: string;
  /**
   * What this wallet holds, or null when balances were not loaded. The page
   * does not wait on them: reading every wallet's balances took seconds and
   * nothing on the form renders one (PRO-1851). Null is never read as zero.
   */
  balances: DvpWalletBalance[] | null;
};

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

/**
 * The subset of `/v1/issuance/tokens` this form uses.
 *
 * Mirrors `RawToken` in `issuance-tokens.data.ts` rather than being guessed:
 * the list carries no token program and its `extensions` is an object about
 * the permanent delegate, NOT the Token-2022 extension set. So it cannot tell
 * us whether DvP will accept a mint, and pretending otherwise would put a
 * confident wrong answer in front of someone.
 */
interface TokenRow {
  id?: string;
  mintAddress?: string | null;
  name?: string | null;
  symbol?: string | null;
  decimals?: number;
}

const walletBalanceRowSchema = z.object({
  mint: z.string().nullish(),
  amount: z.string().nullish(),
  decimals: z.number().nullish(),
  token: z.string().nullish(),
});

type WalletBalanceRow = z.infer<typeof walletBalanceRowSchema>;

const walletRowSchema = z
  .object({
    id: z.string().min(1),
    publicKey: z.string().min(1),
    label: z.string().nullable().default(null),
    custodyConfigId: z.string().min(1).optional(),
    custodyConnectionId: z.string().min(1).optional(),
    isRuntimeExecutionAllowed: z.boolean(),
    balances: z.array(walletBalanceRowSchema).nullish(),
  })
  .refine(
    (wallet) =>
      (wallet.custodyConfigId !== undefined) !== (wallet.custodyConnectionId !== undefined),
    { message: "Wallet must have exactly one custody owner" }
  );

const walletsResponseSchema = z.object({
  data: z.union([z.array(walletRowSchema), z.object({ wallets: z.array(walletRowSchema) })]),
});

function mapBalances(rows: WalletBalanceRow[]): DvpWalletBalance[] {
  return rows.flatMap((balance) =>
    balance.mint && typeof balance.decimals === "number" && balance.amount
      ? [
          {
            mint: balance.mint,
            amount: balance.amount,
            decimals: balance.decimals,
            // The API falls back to the raw mint when it has no symbol, which
            // is not a label — the field would rather show nothing than repeat
            // the address it is already displaying.
            symbol: balance.token && balance.token !== balance.mint ? balance.token : null,
          },
        ]
      : []
  );
}

function mapWallets(rows: z.infer<typeof walletRowSchema>[]): DvpCreateWallet[] {
  return rows.map((wallet) => ({
    id: wallet.id,
    address: wallet.publicKey,
    label: wallet.label,
    custodyConfigId: wallet.custodyConfigId,
    custodyConnectionId: wallet.custodyConnectionId,
    isRuntimeExecutionAllowed: wallet.isRuntimeExecutionAllowed,
    // Absent or null means the read did not carry balances, which is not "holds nothing".
    balances:
      wallet.balances === undefined || wallet.balances === null
        ? null
        : mapBalances(wallet.balances),
  }));
}

interface CounterpartyAccountRow {
  counterpartyAccountId?: string;
  /** `counterparty_display_name` — the picker's label, always present. */
  name?: string;
  label?: string | null;
  address?: string;
}

function mapCounterpartyAccounts(rows: CounterpartyAccountRow[] | null | undefined) {
  return (rows ?? []).flatMap((account) =>
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

/** Never throws: a form that renders with empty pickers beats a 500. */
export async function fetchDvpCreateContext(
  request: SdpApiClient["request"]
): Promise<DvpCreateContext> {
  try {
    const [walletsResponse, tokensResponse, counterpartiesResponse] = await Promise.all([
      // Without balances. Reading them costs a chain read per wallet, which
      // held the whole form back by five to seven seconds, and no field shows
      // one. Funding still refuses a short balance with the amount named.
      request("/v1/wallets?includeAllProviders=true"),
      request("/v1/issuance/tokens?pageSize=100"),
      // The registered crypto-wallet accounts a slot can name, address resolved
      // server-side the same way create will resolve `counterpartyAccountId`.
      request("/v1/counterparties/accounts?pageSize=100"),
    ]);

    const walletsBody: unknown = await walletsResponse.json().catch(() => ({}));
    const tokensBody = (await tokensResponse.json().catch(() => ({}))) as {
      data?: TokenRow[];
      error?: { message?: string };
    };
    const counterpartiesBody = (await counterpartiesResponse.json().catch(() => ({}))) as {
      data?: { accounts?: CounterpartyAccountRow[] };
      error?: { message?: string };
    };

    if (!walletsResponse.ok) {
      return {
        wallets: [],
        tokens: [],
        counterpartyAccounts: [],
        error:
          z.object({ error: z.object({ message: z.string() }) }).safeParse(walletsBody).data?.error
            .message ?? `Wallet list failed (${walletsResponse.status}).`,
      };
    }

    const parsedWallets = walletsResponseSchema.safeParse(walletsBody);
    if (!parsedWallets.success) {
      return {
        wallets: [],
        tokens: [],
        counterpartyAccounts: [],
        error: "Invalid custody wallet response",
      };
    }
    const walletRows = Array.isArray(parsedWallets.data.data)
      ? parsedWallets.data.data
      : parsedWallets.data.data.wallets;
    // A failed token request must not read as "you have no tokens". Silently
    // returning an empty list would send someone hunting for assets they can
    // see in Issuance.
    if (!tokensResponse.ok) {
      return {
        wallets: mapWallets(walletRows),
        tokens: [],
        counterpartyAccounts: [],
        error: tokensBody.error?.message ?? `Token list failed (${tokensResponse.status}).`,
      };
    }
    const tokenRows = tokensBody.data ?? [];

    // Same rule as the tokens: a counterparty list that failed must not read
    // as "you have no counterparties", which would hide the second-reference
    // option from somebody who uses it daily.
    if (!counterpartiesResponse.ok) {
      return {
        wallets: mapWallets(walletRows),
        tokens: tokenRows.flatMap(toTokenOption),
        counterpartyAccounts: [],
        error:
          counterpartiesBody.error?.message ??
          `Counterparty list failed (${counterpartiesResponse.status}).`,
      };
    }
    const accountRows = counterpartiesBody.data?.accounts ?? [];

    return {
      wallets: mapWallets(walletRows),
      // Only deployed tokens have a mint to trade. A draft has nothing to put
      // in escrow, so offering it would be an invitation to a 400.
      //
      // Whether DvP will ACCEPT a mint is deliberately not decided here. The
      // create endpoint reads the mint on chain and refuses with the offending
      // extension named, which is strictly better than anything this list could
      // claim — it carries no extension data at all.
      tokens: tokenRows.flatMap(toTokenOption),
      counterpartyAccounts: mapCounterpartyAccounts(accountRows),
      error: null,
    };
  } catch (error) {
    return {
      wallets: [],
      tokens: [],
      counterpartyAccounts: [],
      error: error instanceof Error ? error.message : "Could not load trade options.",
    };
  }
}

function toTokenOption(token: TokenRow) {
  return token.mintAddress
    ? [
        {
          mint: token.mintAddress,
          label: token.symbol || token.name || token.mintAddress,
          name: token.name ? token.name : null,
          decimals: typeof token.decimals === "number" ? token.decimals : null,
          // Every SDP-issued asset is minted under Token-2022.
          tokenProgram: SPL_TOKEN_PROGRAMS["token-2022"],
        },
      ]
    : [];
}
