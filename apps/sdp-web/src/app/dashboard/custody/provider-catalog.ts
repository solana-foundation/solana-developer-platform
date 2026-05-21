const DEFAULT_CUSTODY_CAPABILITIES = ["Issuance", "Transfers", "Compliance"] as const;

export const WALLET_PROVIDER_CATEGORIES = ["server", "institutional"] as const;
export type WalletProviderCategory = (typeof WALLET_PROVIDER_CATEGORIES)[number];

export const WALLET_PROVIDER_CATEGORY_DETAILS: Record<
  WalletProviderCategory,
  {
    label: string;
    description: string;
  }
> = {
  server: {
    label: "Server",
    description:
      "Single-key API signers. Provisioned and destroyed via API. Best for issuance, refunds and programmatic flows.",
  },
  institutional: {
    label: "Institutional",
    description:
      "Policy-gated custody with multi-approver quorum, daily limits and full audit trail. Best for treasury, settlement and OTC.",
  },
};

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
  category: WalletProviderCategory;
  supportsAdditionalWallets: boolean;
  capabilities: readonly string[];
}

export const CUSTODY_PROVIDER_CATALOG: CustodyProviderCatalogEntry[] = [
  {
    id: "local",
    label: "Local Signer",
    description: "Self-hosted Ed25519 keypair signer from CUSTODY_PRIVATE_KEY.",
    category: "server",
    supportsAdditionalWallets: false,
    capabilities: ["Issuance", "Transfers"],
  },
  {
    id: "privy",
    label: "Privy",
    description: "Hosted wallet infrastructure for API signing.",
    category: "server",
    supportsAdditionalWallets: true,
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  {
    id: "fireblocks",
    label: "Fireblocks",
    description: "MPC custody with vault-based wallet controls.",
    category: "institutional",
    supportsAdditionalWallets: false,
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  {
    id: "coinbase_cdp",
    label: "Coinbase CDP",
    description: "Programmatic wallet provisioning through Coinbase CDP.",
    category: "server",
    supportsAdditionalWallets: true,
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  {
    id: "para",
    label: "Para",
    description: "Embedded wallet custody for organization-level operations.",
    category: "server",
    supportsAdditionalWallets: true,
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  {
    id: "turnkey",
    label: "Turnkey",
    description: "Policy-based key custody for production signing workloads.",
    category: "server",
    supportsAdditionalWallets: true,
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  {
    id: "dfns",
    label: "DFNS",
    description: "MPC wallet orchestration with secure API-driven signing.",
    category: "institutional",
    supportsAdditionalWallets: true,
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  {
    id: "anchorage",
    label: "Anchorage",
    description: "Institutional custody with wallet lifecycle management.",
    category: "institutional",
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

export function getCustodyProviderEntry(
  provider: KnownCustodyProvider
): CustodyProviderCatalogEntry {
  return (
    CUSTODY_PROVIDER_CATALOG.find((entry) => entry.id === provider) ?? CUSTODY_PROVIDER_CATALOG[0]
  );
}

export function getCustodyProviderCategory(provider: KnownCustodyProvider): WalletProviderCategory {
  return getCustodyProviderEntry(provider).category;
}

export function getCustodyProvidersByCategory(
  category: WalletProviderCategory
): CustodyProviderCatalogEntry[] {
  return CUSTODY_PROVIDER_CATALOG.filter((provider) => provider.category === category);
}
