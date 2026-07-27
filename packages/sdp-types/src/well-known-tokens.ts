import type { SdpEnvironment } from "./api-keys";

export type SolanaCluster = "devnet" | "mainnet-beta";

export const SOLANA_CLUSTER_LABELS = {
  devnet: "Devnet",
  "mainnet-beta": "Mainnet",
} as const satisfies Record<SolanaCluster, string>;

export const SPL_TOKEN_PROGRAMS = {
  // biome-ignore lint/security/noSecrets: Solana SPL Token program ID, not a secret.
  "spl-token": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  // biome-ignore lint/security/noSecrets: Solana Token-2022 program ID, not a secret.
  "token-2022": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
} as const satisfies Record<string, string>;

export type TokenProgramKind = keyof typeof SPL_TOKEN_PROGRAMS;

/** Broad grouping used to organise token pickers; not a protocol-level concept. */
export type WellKnownTokenCategory = "native" | "stablecoin" | "staked-sol" | "wrapped";

/**
 * One cluster's deployment of a token.
 *
 * Decimals live here rather than on the token because they are a property of
 * the mint account, not of the symbol. Two clusters can carry the same ticker
 * at different scales — the account at the mainnet USDS address is a 6-decimal
 * mint, while the account at that same address on devnet is an unrelated
 * 9-decimal mint — and a single token-level `decimals` cannot express that
 * without silently misscaling one of them.
 */
export interface WellKnownTokenMint {
  address: string;
  decimals: number;
}

export interface WellKnownToken {
  /** Display casing, e.g. "JitoSOL". Object keys stay uppercase. */
  symbol: string;
  /** Full name, shown alongside the symbol where there is room. */
  name: string;
  /**
   * True only for tokens that track 1 USD closely enough to be priced at $1
   * without a feed. EUR-denominated and yield-bearing tokens are not stable
   * in this sense even though they are commonly called stablecoins.
   */
  isUsdStable: boolean;
  tokenProgram: TokenProgramKind;
  category: WellKnownTokenCategory;
  /** Mints by cluster; mainnet is always present, devnet only when the token is deployed there. */
  mints: { "mainnet-beta": WellKnownTokenMint; devnet?: WellKnownTokenMint };
}

/**
 * A catalogue entry resolved to one cluster's mint, which is what a caller
 * holding a mint address actually has. `decimals` is that mint's own scale.
 */
export interface WellKnownTokenAtMint extends Omit<WellKnownToken, "mints"> {
  address: string;
  decimals: number;
  /**
   * Clusters on which this address is the token's mint. Usually one, but
   * several tokens (EURC, JitoSOL, mSOL, bSOL) are deployed at the same
   * address on both, so callers checking cluster validity must not assume one.
   */
  clusters: readonly SolanaCluster[];
}

/** Native SOL pseudo-mint (wrapped SOL), identical across clusters. */
// biome-ignore lint/security/noSecrets: Solana native SOL mint address constant, not a secret.
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Lamports per SOL expressed as decimal places. Fixed by the runtime rather
 * than by a mint account, so it is the same on every cluster — unlike SPL
 * token decimals, which callers must resolve per mint.
 */
export const SOL_DECIMALS = 9;

/**
 * Curated catalogue of tokens offered as suggestions in pickers.
 *
 * Every mint here is pinned deliberately. Solana's production-readiness guidance
 * is to hardcode or allowlist mint addresses rather than resolve them from a
 * registry at runtime, because spoofed tokens share the name and symbol of the
 * real asset and only the mint distinguishes them. Devnet and mainnet are
 * separate deployments, so a token appears on a cluster only when it has a
 * verified mint there.
 *
 * Every entry here — address, decimals and owning token program — was verified
 * against mainnet and devnet before being added, which is how USDG was found to
 * be a Token-2022 mint and how the devnet account at the USDS address was found
 * to be an unrelated 9-decimal mint rather than USDS.
 *
 * After adding or changing an entry, check it against chain with
 * `pnpm check:well-known-mints` from the repository root. That confirms, for
 * every cluster a token is declared on, that the account parses as a mint, that
 * its decimals match, and that its owner is the declared token program. It is
 * not in CI because it needs public RPC, so it only helps if you run it.
 *
 * Never add an address copied from a chat or a search result — spoofed tokens
 * share the name and symbol of the real asset, and only the mint distinguishes
 * them.
 */
export const WELL_KNOWN_TOKENS = {
  SOL: {
    symbol: "SOL",
    name: "Solana",
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "native",
    mints: {
      devnet: { address: SOL_MINT, decimals: 9 },
      "mainnet-beta": { address: SOL_MINT, decimals: 9 },
    },
  },
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    isUsdStable: true,
    tokenProgram: "spl-token",
    category: "stablecoin",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet USDC mint address constant, not a secret.
      devnet: { address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6 },
      // biome-ignore lint/security/noSecrets: Mainnet USDC mint address constant, not a secret.
      "mainnet-beta": { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
    },
  },
  USDT: {
    symbol: "USDT",
    name: "Tether USD",
    isUsdStable: true,
    tokenProgram: "spl-token",
    category: "stablecoin",
    mints: {
      // biome-ignore lint/security/noSecrets: Mainnet USDT mint address constant, not a secret.
      "mainnet-beta": { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
    },
  },
  USDG: {
    symbol: "USDG",
    name: "Global Dollar",
    isUsdStable: true,
    tokenProgram: "token-2022",
    category: "stablecoin",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet USDG mint address constant, not a secret.
      devnet: { address: "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7", decimals: 6 },
      // biome-ignore lint/security/noSecrets: Mainnet USDG mint address constant, not a secret.
      "mainnet-beta": { address: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", decimals: 6 },
    },
  },
  PYUSD: {
    symbol: "PYUSD",
    name: "PayPal USD",
    isUsdStable: true,
    tokenProgram: "token-2022",
    category: "stablecoin",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet PYUSD mint address constant, not a secret.
      devnet: { address: "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM", decimals: 6 },
      // biome-ignore lint/security/noSecrets: Mainnet PYUSD mint address constant, not a secret.
      "mainnet-beta": { address: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", decimals: 6 },
    },
  },
  USDS: {
    symbol: "USDS",
    name: "USDS",
    isUsdStable: true,
    tokenProgram: "spl-token",
    category: "stablecoin",
    mints: {
      // Devnet deliberately omitted. An account does exist at this address on
      // devnet and it does parse as a mint, but it carries 9 decimals and zero
      // supply — it is not USDS, so listing it would offer a token nobody can
      // actually hold and misscale any amount shown for it.
      // biome-ignore lint/security/noSecrets: Mainnet USDS mint address constant, not a secret.
      "mainnet-beta": { address: "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", decimals: 6 },
    },
  },
  USDY: {
    symbol: "USDY",
    name: "Ondo US Dollar Yield",
    // Yield-bearing: redeems above 1 USD and drifts upward, so it must not be
    // priced at $1 the way a pegged stablecoin is.
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "stablecoin",
    mints: {
      // biome-ignore lint/security/noSecrets: Mainnet USDY mint address constant, not a secret.
      "mainnet-beta": { address: "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6", decimals: 6 },
    },
  },
  EURC: {
    symbol: "EURC",
    name: "Euro Coin",
    // Euro-denominated, so not USD-stable despite being a fiat-backed stablecoin.
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "stablecoin",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet EURC mint address constant, not a secret.
      devnet: { address: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr", decimals: 6 },
      // biome-ignore lint/security/noSecrets: Mainnet EURC mint address constant, not a secret.
      "mainnet-beta": { address: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr", decimals: 6 },
    },
  },
  JITOSOL: {
    symbol: "JitoSOL",
    name: "Jito Staked SOL",
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "staked-sol",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet JitoSOL mint address constant, not a secret.
      devnet: { address: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", decimals: 9 },
      // biome-ignore lint/security/noSecrets: Mainnet JitoSOL mint address constant, not a secret.
      "mainnet-beta": { address: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", decimals: 9 },
    },
  },
  MSOL: {
    symbol: "mSOL",
    name: "Marinade Staked SOL",
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "staked-sol",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet mSOL mint address constant, not a secret.
      devnet: { address: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", decimals: 9 },
      // biome-ignore lint/security/noSecrets: Mainnet mSOL mint address constant, not a secret.
      "mainnet-beta": { address: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", decimals: 9 },
    },
  },
  BSOL: {
    symbol: "bSOL",
    name: "BlazeStake Staked SOL",
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "staked-sol",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet bSOL mint address constant, not a secret.
      devnet: { address: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", decimals: 9 },
      // biome-ignore lint/security/noSecrets: Mainnet bSOL mint address constant, not a secret.
      "mainnet-beta": { address: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", decimals: 9 },
    },
  },
  INF: {
    symbol: "INF",
    name: "Sanctum Infinity",
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "staked-sol",
    mints: {
      // biome-ignore lint/security/noSecrets: Mainnet INF mint address constant, not a secret.
      "mainnet-beta": { address: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm", decimals: 9 },
    },
  },
  CBBTC: {
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "wrapped",
    mints: {
      // biome-ignore lint/security/noSecrets: Mainnet cbBTC mint address constant, not a secret.
      "mainnet-beta": { address: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", decimals: 8 },
    },
  },
  WBTC: {
    symbol: "WBTC",
    name: "Wrapped BTC (Portal)",
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "wrapped",
    mints: {
      // biome-ignore lint/security/noSecrets: Mainnet WBTC mint address constant, not a secret.
      "mainnet-beta": { address: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", decimals: 8 },
    },
  },
} as const satisfies Record<string, WellKnownToken>;

export type WellKnownTokenSymbol = keyof typeof WELL_KNOWN_TOKENS;

/**
 * Lookup from any cluster's mint address to its catalogue entry, carrying that
 * mint's own decimals. Tokens deployed at the same address on both clusters
 * (EURC, JitoSOL, mSOL, bSOL) collapse to one entry, so dedupe is by address
 * rather than by object identity.
 */
export const WELL_KNOWN_TOKEN_BY_MINT: ReadonlyMap<string, WellKnownTokenAtMint> = new Map(
  Object.values(WELL_KNOWN_TOKENS).flatMap(({ mints, ...token }) => {
    const byAddress = new Map<string, WellKnownTokenAtMint>();
    for (const [cluster, mint] of Object.entries(mints) as [SolanaCluster, WellKnownTokenMint][]) {
      const seen = byAddress.get(mint.address);
      byAddress.set(
        mint.address,
        seen
          ? { ...seen, clusters: [...seen.clusters, cluster] }
          : { ...token, address: mint.address, decimals: mint.decimals, clusters: [cluster] }
      );
    }
    return [...byAddress];
  })
);

export const CLUSTER_BY_SDP_ENVIRONMENT = {
  sandbox: "devnet",
  production: "mainnet-beta",
} as const satisfies Record<SdpEnvironment, SolanaCluster>;

export function isWellKnownTokenSymbol(value: string): value is WellKnownTokenSymbol {
  return Object.hasOwn(WELL_KNOWN_TOKENS, value);
}

export function wellKnownMint(
  symbol: WellKnownTokenSymbol,
  cluster: SolanaCluster
): string | undefined {
  const token: WellKnownToken = WELL_KNOWN_TOKENS[symbol];
  return token.mints[cluster]?.address;
}

/**
 * Decimals for a token on one cluster. Undefined when the token is not
 * deployed there — callers must not fall back to another cluster's scale.
 */
export function wellKnownDecimals(
  symbol: WellKnownTokenSymbol,
  cluster: SolanaCluster
): number | undefined {
  const token: WellKnownToken = WELL_KNOWN_TOKENS[symbol];
  return token.mints[cluster]?.decimals;
}
