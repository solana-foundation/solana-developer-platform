/**
 * The mints Rings will operate on.
 *
 * Global rather than per-project: the allowlist reflects what the shielded pool
 * and the platform's token registry both support on devnet, which is not a
 * per-tenant decision. Read-only here — 0057 seeds it, and disabling a mint is
 * an operator action against the table rather than an API surface.
 */
export interface HeliusRingsAssetRow {
  mint: string;
  symbol: string;
  decimals: number;
  status: "active" | "disabled";
}

export interface HeliusRingsAssetRepository {
  /** Active mints only; a disabled one must neither be offered nor labelled. */
  listActiveAssets(): Promise<HeliusRingsAssetRow[]>;
}
