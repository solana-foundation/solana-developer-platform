import type { SdpApiClient } from "@/lib/sdp-api";

/**
 * What the create form needs to offer real choices instead of blank fields.
 *
 * The asset leg comes from the organization's own issued tokens — Zach:
 * "definitely tied to assets from issuance" — so the common case is picking a
 * token you already made rather than pasting a mint address you have to go and
 * look up.
 */

export interface DvpCreateOption {
  /** The mint address, which is what the API actually takes. */
  mint: string;
  label: string;
  /**
   * Lets the form take a human amount and convert it. Null when unknown, in
   * which case the field falls back to base units rather than guessing a scale
   * and moving the wrong quantity.
   */
  decimals: number | null;
}

export interface DvpCreateWallet {
  /** `custody_wallets.id` — the record id the API expects as sdpWalletId. */
  id: string;
  address: string;
  label: string | null;
}

export interface DvpCreateContext {
  wallets: DvpCreateWallet[];
  tokens: DvpCreateOption[];
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

interface WalletRow {
  id?: string;
  publicKey?: string;
  label?: string | null;
}

function mapWallets(rows: WalletRow[]): DvpCreateWallet[] {
  return rows.flatMap((wallet) =>
    wallet.id && wallet.publicKey
      ? [{ id: wallet.id, address: wallet.publicKey, label: wallet.label ?? null }]
      : []
  );
}

/** Never throws: a form that renders with empty pickers beats a 500. */
export async function fetchDvpCreateContext(
  request: SdpApiClient["request"]
): Promise<DvpCreateContext> {
  try {
    const [walletsResponse, tokensResponse] = await Promise.all([
      request("/v1/wallets"),
      request("/v1/issuance/tokens?pageSize=100"),
    ]);

    const walletsBody = (await walletsResponse.json().catch(() => ({}))) as {
      data?: WalletRow[] | { wallets?: WalletRow[] };
      error?: { message?: string };
    };
    const tokensBody = (await tokensResponse.json().catch(() => ({}))) as {
      data?: TokenRow[];
      error?: { message?: string };
    };

    if (!walletsResponse.ok) {
      return {
        wallets: [],
        tokens: [],
        error: walletsBody.error?.message ?? `Wallet list failed (${walletsResponse.status}).`,
      };
    }

    const walletRows = Array.isArray(walletsBody.data)
      ? walletsBody.data
      : (walletsBody.data?.wallets ?? []);
    // A failed token request must not read as "you have no tokens". Silently
    // returning an empty list would send someone hunting for assets they can
    // see in Issuance.
    if (!tokensResponse.ok) {
      return {
        wallets: mapWallets(walletRows),
        tokens: [],
        error: tokensBody.error?.message ?? `Token list failed (${tokensResponse.status}).`,
      };
    }
    const tokenRows = tokensBody.data ?? [];

    return {
      wallets: mapWallets(walletRows),
      // Only deployed tokens have a mint to trade. A draft has nothing to put
      // in escrow, so offering it would be an invitation to a 400.
      //
      // Whether DvP will ACCEPT a mint is deliberately not decided here. The
      // create endpoint reads the mint on chain and refuses with the offending
      // extension named, which is strictly better than anything this list could
      // claim — it carries no extension data at all.
      tokens: tokenRows.flatMap((token) =>
        token.mintAddress
          ? [
              {
                mint: token.mintAddress,
                label: token.symbol || token.name || token.mintAddress,
                decimals: typeof token.decimals === "number" ? token.decimals : null,
              },
            ]
          : []
      ),
      error: null,
    };
  } catch (error) {
    return {
      wallets: [],
      tokens: [],
      error: error instanceof Error ? error.message : "Could not load trade options.",
    };
  }
}
