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
  tokenProgram: string;
  /** Extensions the DvP program refuses; present means the token is unusable. */
  blockedReason: string | null;
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

interface TokenRow {
  mintAddress?: string | null;
  name?: string | null;
  symbol?: string | null;
  tokenProgram?: string | null;
  extensions?: string[] | null;
}

interface WalletRow {
  id?: string;
  publicKey?: string;
  label?: string | null;
}

/**
 * Extensions the DvP swap program refuses at CreateDvp and SettleDvp alike.
 *
 * Mirrors the server-side deny-list. Shown here so a token that cannot be
 * traded is visibly unusable at the point of choosing, rather than a 400 after
 * filling in the whole form.
 */
const BLOCKED_EXTENSIONS: Readonly<Record<string, string>> = {
  transferFee: "transfer fee",
  interestBearing: "interest-bearing",
  scaledUiAmount: "scaled display amount",
  nonTransferable: "non-transferable",
};

function blockedReason(extensions: string[] | null | undefined): string | null {
  const hit = (extensions ?? []).find((extension) => extension in BLOCKED_EXTENSIONS);
  return hit ? BLOCKED_EXTENSIONS[hit] : null;
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
      data?: TokenRow[] | { tokens?: TokenRow[] };
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
    const tokenRows = Array.isArray(tokensBody.data)
      ? tokensBody.data
      : (tokensBody.data?.tokens ?? []);

    return {
      wallets: walletRows.flatMap((wallet) =>
        wallet.id && wallet.publicKey
          ? [{ id: wallet.id, address: wallet.publicKey, label: wallet.label ?? null }]
          : []
      ),
      // Only deployed tokens have a mint to trade. A draft has nothing to put
      // in escrow, so offering it would be an invitation to a 400.
      tokens: tokenRows.flatMap((token) =>
        token.mintAddress
          ? [
              {
                mint: token.mintAddress,
                label: token.symbol || token.name || token.mintAddress,
                tokenProgram: token.tokenProgram ?? "",
                blockedReason: blockedReason(token.extensions),
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
