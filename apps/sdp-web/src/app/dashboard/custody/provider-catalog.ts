const DEFAULT_CUSTODY_CAPABILITIES = ["Issuance", "Transfers", "Compliance"] as const;

export type KnownCustodyProvider =
  | "local"
  | "privy"
  | "fireblocks"
  | "coinbase_cdp"
  | "para"
  | "turnkey"
  | "dfns"
  | "anchorage";

export interface CustodyProviderCatalogEntry {
  id: KnownCustodyProvider;
  label: string;
  description: string;
  supportsAdditionalWallets: boolean;
  capabilities: readonly string[];
}

export const CUSTODY_PROVIDER_CATALOG: CustodyProviderCatalogEntry[] = [
  {
    id: "local",
    label: "Local Signer",
    description: "Self-hosted Ed25519 keypair signer from CUSTODY_PRIVATE_KEY.",
    supportsAdditionalWallets: false,
    capabilities: ["Issuance", "Transfers"],
  },
  {
    id: "privy",
    label: "Privy",
    description: "Hosted wallet infrastructure for API signing.",
    supportsAdditionalWallets: true,
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  {
    id: "fireblocks",
    label: "Fireblocks",
    description: "MPC custody with vault-based wallet controls.",
    supportsAdditionalWallets: false,
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  {
    id: "coinbase_cdp",
    label: "Coinbase CDP",
    description: "Programmatic wallet provisioning through Coinbase CDP.",
    supportsAdditionalWallets: true,
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  {
    id: "para",
    label: "Para",
    description: "Embedded wallet custody for organization-level operations.",
    supportsAdditionalWallets: true,
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  {
    id: "turnkey",
    label: "Turnkey",
    description: "Policy-based key custody for production signing workloads.",
    supportsAdditionalWallets: true,
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  {
    id: "dfns",
    label: "DFNS",
    description: "MPC wallet orchestration with secure API-driven signing.",
    supportsAdditionalWallets: true,
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  {
    id: "anchorage",
    label: "Anchorage",
    description: "Institutional custody with wallet lifecycle management.",
    supportsAdditionalWallets: true,
    capabilities: ["Transfers", "Compliance"],
  },
];

const PROVIDER_LABELS = new Map(
  CUSTODY_PROVIDER_CATALOG.map((provider) => [provider.id, provider.label])
);

const PROVIDER_SET = new Set<KnownCustodyProvider>(
  CUSTODY_PROVIDER_CATALOG.map((provider) => provider.id)
);

export function isKnownCustodyProvider(value: string): value is KnownCustodyProvider {
  return PROVIDER_SET.has(value as KnownCustodyProvider);
}

export function formatCustodyProviderName(provider: string): string {
  return PROVIDER_LABELS.get(provider as KnownCustodyProvider) ?? provider;
}
