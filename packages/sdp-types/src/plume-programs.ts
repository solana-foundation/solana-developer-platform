import type { SolanaCluster } from "./well-known-tokens";

/** Public mainnet deployments from Plume's nOPAL integration guide (2026-11-02).
 * These are protocol identities, not a promise that SDP has enabled a vault.
 * nBND must be added only after Plume supplies and SDP verifies its deployment.
 */
export const PLUME_API_BASE_URL = "https://api.nest.credit/v1";
export const PLUME_CHAIN_ID = 98866;
export const PLUME_CCTP_DOMAIN = 22;
export const PLUME_ENDPOINT_ID = 30370;
export const PLUME_SOLANA_ENDPOINT_ID = 30168;
export const PLUME_PROGRAMS = {
  // biome-ignore lint/security/noSecrets: public pinned Plume deployment address.
  oft: "ChEfPd3RzLeYiRwp1K9evimmaFSd6DV1S4Mv5q5Aj1th",
  // biome-ignore lint/security/noSecrets: public pinned Plume deployment address.
  endpoint: "76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6",
  // biome-ignore lint/security/noSecrets: public pinned Plume deployment address.
  tokenMessenger: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
  // biome-ignore lint/security/noSecrets: public pinned Plume deployment address.
  messageTransmitter: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
} as const;

export interface PlumeVaultDeployment {
  cluster: SolanaCluster;
  slug: string;
  name: string;
  shareMint: string;
  shareDecimals: number;
  plumeShareDecimals: number;
  oftStore: string;
  tokenEscrow: string;
  mintComposer: string;
  redemptionComposer: string;
  relayer: string;
  lookupTable: string;
}

export const PLUME_VAULTS: readonly PlumeVaultDeployment[] = [
  {
    cluster: "mainnet-beta",
    slug: "nest-opal-vault",
    name: "Plume BlackOpal LiquidStone II (nOPAL)",
    // biome-ignore lint/security/noSecrets: public pinned Plume deployment address.
    shareMint: "GArhnnDj3GYhmQeApKVXaRv4TQFwhPcs3SNF6FXsTeXq",
    shareDecimals: 6,
    plumeShareDecimals: 6,
    // biome-ignore lint/security/noSecrets: public pinned Plume deployment address.
    oftStore: "FmeHf1FQJhXUWHVfLACCHJ8KvAJ7jpiDvukz8ZHP7XLq",
    // biome-ignore lint/security/noSecrets: public pinned Plume deployment address.
    tokenEscrow: "HsxiyEkJgDRCspdyu9guUHsAN5xCwQBG13XGcsaYJQq",
    // biome-ignore lint/security/noSecrets: public pinned Plume deployment address.
    mintComposer: "0x8b5719c762519af58723efffbe1e47ff80ceb823",
    // biome-ignore lint/security/noSecrets: public pinned Plume deployment address.
    redemptionComposer: "0x9053e541c4bf3f44a8dbb7e25625639b6d0b62c9",
    // biome-ignore lint/security/noSecrets: public pinned Plume deployment address.
    relayer: "0x7de01896d36bea9cf072ac64e41685418941d8be",
    // biome-ignore lint/security/noSecrets: public pinned Plume deployment address.
    lookupTable: "2Hd1BW1xK5wPZB8zKm9Diu9zvadZJSpK47QyP6CbedM6",
  },
];

/** References are share mints, not slugs: this also keeps cluster mirrors disjoint. */
export function plumeVault(
  cluster: SolanaCluster,
  reference: string
): PlumeVaultDeployment | undefined {
  return PLUME_VAULTS.find((vault) => vault.cluster === cluster && vault.shareMint === reference);
}
