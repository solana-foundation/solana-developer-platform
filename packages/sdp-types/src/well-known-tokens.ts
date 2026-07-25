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

export interface WellKnownToken {
  /** Display casing, e.g. "JitoSOL". Object keys stay uppercase. */
  symbol: string;
  /** Full name, shown alongside the symbol where there is room. */
  name: string;
  decimals: number;
  /**
   * True only for tokens that track 1 USD closely enough to be priced at $1
   * without a feed. EUR-denominated and yield-bearing tokens are not stable
   * in this sense even though they are commonly called stablecoins.
   */
  isUsdStable: boolean;
  tokenProgram: TokenProgramKind;
  category: WellKnownTokenCategory;
  /** Mint addresses by cluster; mainnet is always present, devnet only when the token is deployed there. */
  mints: { "mainnet-beta": string; devnet?: string };
}

/** Native SOL pseudo-mint (wrapped SOL), identical across clusters. */
// biome-ignore lint/security/noSecrets: Solana native SOL mint address constant, not a secret.
export const SOL_MINT = "So11111111111111111111111111111111111111112";

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
 * be a Token-2022 mint and how devnet USDS was rejected for having different
 * decimals than its mainnet counterpart.
 *
 * There is no automated conformance check yet. Until there is, verify a new
 * entry against chain yourself with getAccountInfo (jsonParsed) on the target
 * cluster and confirm the account is a mint, its decimals match, and its owner
 * matches the declared tokenProgram. Never add an address copied from a chat or
 * a search result: spoofed tokens share the name and symbol of the real asset.
 */
export const WELL_KNOWN_TOKENS = {
  SOL: {
    symbol: "SOL",
    name: "Solana",
    decimals: 9,
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "native",
    mints: {
      devnet: SOL_MINT,
      "mainnet-beta": SOL_MINT,
    },
  },
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    isUsdStable: true,
    tokenProgram: "spl-token",
    category: "stablecoin",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet USDC mint address constant, not a secret.
      devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      // biome-ignore lint/security/noSecrets: Mainnet USDC mint address constant, not a secret.
      "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    },
  },
  USDT: {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    isUsdStable: true,
    tokenProgram: "spl-token",
    category: "stablecoin",
    mints: {
      // biome-ignore lint/security/noSecrets: Mainnet USDT mint address constant, not a secret.
      "mainnet-beta": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    },
  },
  USDG: {
    symbol: "USDG",
    name: "Global Dollar",
    decimals: 6,
    isUsdStable: true,
    tokenProgram: "token-2022",
    category: "stablecoin",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet USDG mint address constant, not a secret.
      devnet: "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7",
      // biome-ignore lint/security/noSecrets: Mainnet USDG mint address constant, not a secret.
      "mainnet-beta": "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
    },
  },
  PYUSD: {
    symbol: "PYUSD",
    name: "PayPal USD",
    decimals: 6,
    isUsdStable: true,
    tokenProgram: "token-2022",
    category: "stablecoin",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet PYUSD mint address constant, not a secret.
      devnet: "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM",
      // biome-ignore lint/security/noSecrets: Mainnet PYUSD mint address constant, not a secret.
      "mainnet-beta": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
    },
  },
  USDS: {
    symbol: "USDS",
    name: "USDS",
    decimals: 6,
    isUsdStable: true,
    tokenProgram: "spl-token",
    category: "stablecoin",
    mints: {
      // Devnet deliberately omitted: an account exists at this address on devnet
      // but it is a different mint with 9 decimals, which would misscale amounts.
      // biome-ignore lint/security/noSecrets: Mainnet USDS mint address constant, not a secret.
      "mainnet-beta": "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
    },
  },
  USDY: {
    symbol: "USDY",
    name: "Ondo US Dollar Yield",
    // Yield-bearing: redeems above 1 USD and drifts upward, so it must not be
    // priced at $1 the way a pegged stablecoin is.
    decimals: 6,
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "stablecoin",
    mints: {
      // biome-ignore lint/security/noSecrets: Mainnet USDY mint address constant, not a secret.
      "mainnet-beta": "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6",
    },
  },
  EURC: {
    symbol: "EURC",
    name: "Euro Coin",
    // Euro-denominated, so not USD-stable despite being a fiat-backed stablecoin.
    decimals: 6,
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "stablecoin",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet EURC mint address constant, not a secret.
      devnet: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
      // biome-ignore lint/security/noSecrets: Mainnet EURC mint address constant, not a secret.
      "mainnet-beta": "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
    },
  },
  JITOSOL: {
    symbol: "JitoSOL",
    name: "Jito Staked SOL",
    decimals: 9,
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "staked-sol",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet JitoSOL mint address constant, not a secret.
      devnet: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
      // biome-ignore lint/security/noSecrets: Mainnet JitoSOL mint address constant, not a secret.
      "mainnet-beta": "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    },
  },
  MSOL: {
    symbol: "mSOL",
    name: "Marinade Staked SOL",
    decimals: 9,
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "staked-sol",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet mSOL mint address constant, not a secret.
      devnet: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
      // biome-ignore lint/security/noSecrets: Mainnet mSOL mint address constant, not a secret.
      "mainnet-beta": "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    },
  },
  BSOL: {
    symbol: "bSOL",
    name: "BlazeStake Staked SOL",
    decimals: 9,
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "staked-sol",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet bSOL mint address constant, not a secret.
      devnet: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
      // biome-ignore lint/security/noSecrets: Mainnet bSOL mint address constant, not a secret.
      "mainnet-beta": "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
    },
  },
  INF: {
    symbol: "INF",
    name: "Sanctum Infinity",
    decimals: 9,
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "staked-sol",
    mints: {
      // biome-ignore lint/security/noSecrets: Mainnet INF mint address constant, not a secret.
      "mainnet-beta": "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",
    },
  },
  CBBTC: {
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    decimals: 8,
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "wrapped",
    mints: {
      // biome-ignore lint/security/noSecrets: Mainnet cbBTC mint address constant, not a secret.
      "mainnet-beta": "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    },
  },
  WBTC: {
    symbol: "WBTC",
    name: "Wrapped BTC (Portal)",
    decimals: 8,
    isUsdStable: false,
    tokenProgram: "spl-token",
    category: "wrapped",
    mints: {
      // biome-ignore lint/security/noSecrets: Mainnet WBTC mint address constant, not a secret.
      "mainnet-beta": "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
    },
  },
} as const satisfies Record<string, WellKnownToken>;

export type WellKnownTokenSymbol = keyof typeof WELL_KNOWN_TOKENS;

/** Lookup from any cluster's mint address to its well-known token definition. */
export const WELL_KNOWN_TOKEN_BY_MINT: ReadonlyMap<string, WellKnownToken> = new Map(
  Object.values(WELL_KNOWN_TOKENS).flatMap((token) =>
    [...new Set(Object.values(token.mints))].map((mint): [string, WellKnownToken] => [mint, token])
  )
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
  return token.mints[cluster];
}
