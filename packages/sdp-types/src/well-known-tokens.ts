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

export interface WellKnownToken {
  symbol: string;
  decimals: number;
  isUsdStable: boolean;
  tokenProgram: TokenProgramKind;
  /** Mint addresses by cluster; mainnet is always present, devnet only when the token is deployed there. */
  mints: { "mainnet-beta": string; devnet?: string };
}

/** Native SOL pseudo-mint (wrapped SOL), identical across clusters. */
// biome-ignore lint/security/noSecrets: Solana native SOL mint address constant, not a secret.
export const SOL_MINT = "So11111111111111111111111111111111111111112";

export const WELL_KNOWN_TOKENS = {
  SOL: {
    symbol: "SOL",
    decimals: 9,
    isUsdStable: false,
    tokenProgram: "spl-token",
    mints: {
      devnet: SOL_MINT,
      "mainnet-beta": SOL_MINT,
    },
  },
  USDC: {
    symbol: "USDC",
    decimals: 6,
    isUsdStable: true,
    tokenProgram: "spl-token",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet USDC mint address constant, not a secret.
      devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      // biome-ignore lint/security/noSecrets: Mainnet USDC mint address constant, not a secret.
      "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    },
  },
  USDT: {
    symbol: "USDT",
    decimals: 6,
    isUsdStable: true,
    tokenProgram: "spl-token",
    mints: {
      // biome-ignore lint/security/noSecrets: Mainnet USDT mint address constant, not a secret.
      "mainnet-beta": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    },
  },
  USDG: {
    symbol: "USDG",
    decimals: 6,
    isUsdStable: true,
    tokenProgram: "spl-token",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet USDG mint address constant, not a secret.
      devnet: "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7",
      // biome-ignore lint/security/noSecrets: Mainnet USDG mint address constant, not a secret.
      "mainnet-beta": "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
    },
  },
  PYUSD: {
    symbol: "PYUSD",
    decimals: 6,
    isUsdStable: true,
    tokenProgram: "token-2022",
    mints: {
      // biome-ignore lint/security/noSecrets: Devnet PYUSD mint address constant, not a secret.
      devnet: "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM",
      // biome-ignore lint/security/noSecrets: Mainnet PYUSD mint address constant, not a secret.
      "mainnet-beta": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
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
