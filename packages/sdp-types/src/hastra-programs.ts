import type { EarnDepositTokenSymbol } from "./earn";
import { type SolanaCluster, wellKnownMint } from "./well-known-tokens";

/**
 * Hastra's two-program Solana deployment for the PRIME strategy.
 *
 * `vault-mint` wraps USDC into wYLDS. `vault-stake` then deposits that wYLDS
 * and mints PRIME shares. Keeping both program ids and both receipt-token
 * mints in one registry prevents the catalogue and transaction builder from
 * silently describing different deployments.
 */
export interface HastraDeployment {
  /** Hastra `vault-mint`: USDC <-> wYLDS. */
  vaultMintProgramAddress: string;
  /** Hastra `vault-stake`: wYLDS <-> PRIME. */
  vaultStakeProgramAddress: string;
  /** The 1:1 YLDS wrapper received from `vault-mint`. */
  wYldsMint: string;
  /** The non-rebasing share token for the Figure Democratized Prime pool. */
  primeMint: string;
  /** Both Hastra tokens use the same atomic-unit scale as USDC. */
  decimals: 6;
  /** Audited source release whose ids and instruction layouts SDP implements. */
  release: "v0.0.6";
  /** Exact public source revision behind the verified release. */
  sourceCommit: string;
}

/** The funding asset accepted by SDP's Hastra route. */
export const HASTRA_DEPOSIT_TOKEN_SYMBOLS = [
  "USDC",
] as const satisfies readonly EarnDepositTokenSymbol[];

/**
 * Verified Hastra deployment identities.
 *
 * The v0.0.6 source revision is pinned because the public integration guide
 * still describes older redemption semantics in places. These addresses and
 * the deployed program binaries were independently matched to commit
 * `121e4cc600b976a97faa018359e00bda48113ec2` before this registry was added.
 * Hastra publishes devnet program identities, but SDP has not verified and
 * admitted a complete devnet token/config deployment. A placeholder must
 * never be put there: sandbox receives the row only through the browse-only
 * mainnet mirror.
 */
export const HASTRA_DEPLOYMENTS: Readonly<Record<SolanaCluster, HastraDeployment | null>> = {
  "mainnet-beta": {
    // biome-ignore lint/security/noSecrets: public on-chain program id, not a credential.
    vaultMintProgramAddress: "9WUyNREiPDMgwMh5Gt81Fd3JpiCKxpjZ5Dpq9Bo1RhMV",
    // biome-ignore lint/security/noSecrets: public on-chain program id, not a credential.
    vaultStakeProgramAddress: "97V7JsExNC6yFWu5KjK1FLfVkNVvtMpAFL5QkLWKEGxY",
    // biome-ignore lint/security/noSecrets: public SPL token mint, not a credential.
    wYldsMint: "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih",
    // biome-ignore lint/security/noSecrets: public SPL token mint, not a credential.
    primeMint: "3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7",
    decimals: 6,
    release: "v0.0.6",
    // biome-ignore lint/security/noSecrets: public Git commit id, not a credential.
    sourceCommit: "121e4cc600b976a97faa018359e00bda48113ec2",
  },
  devnet: null,
};

/** The verified Hastra deployment for `cluster`, or `null`. */
export function hastraDeployment(cluster: SolanaCluster): HastraDeployment | null {
  return HASTRA_DEPLOYMENTS[cluster] ?? null;
}

/** True only on a cluster where Hastra has a verified deployment. */
export function isHastraDeployed(cluster: SolanaCluster): boolean {
  return hastraDeployment(cluster) !== null;
}

/** USDC mint(s) SDP admits to the Hastra deposit path on `cluster`. */
export function hastraDepositMints(cluster: SolanaCluster): readonly string[] {
  if (!isHastraDeployed(cluster)) return [];
  return HASTRA_DEPOSIT_TOKEN_SYMBOLS.map((symbol) => wellKnownMint(symbol, cluster)).filter(
    (mint): mint is string => mint !== undefined
  );
}

/** Exact-mint admission check shared by catalogue and execution. */
export function isHastraDepositMint(mint: string, cluster: SolanaCluster): boolean {
  return hastraDepositMints(cluster).includes(mint);
}
