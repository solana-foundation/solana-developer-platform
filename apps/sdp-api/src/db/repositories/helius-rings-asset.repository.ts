import type { RepositoryDbClient } from "./base";

/** One row of the platform-level Rings mint allowlist. */
export interface HeliusRingsAssetAllowlistRow {
  mint: string;
  symbol: string;
  decimals: number;
  status: "active" | "disabled";
}

export interface HeliusRingsAssetRepositoryContext {
  db: RepositoryDbClient;
}

export interface HeliusRingsAssetRepository {
  /** Active allowlist entry for this mint, or null if unknown or disabled. */
  getActiveByMint(mint: string): Promise<HeliusRingsAssetAllowlistRow | null>;
  listActive(): Promise<HeliusRingsAssetAllowlistRow[]>;
}
