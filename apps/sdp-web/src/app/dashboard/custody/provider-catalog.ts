import {
  CUSTODY_PROVIDER_CAPABILITIES,
  type CustodyProvider,
  type CustodyProviderCapabilities,
} from "@sdp/types";

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
    label: "API",
    description: "Wallet infrastructure for API-driven product, operations, and automated flows.",
  },
  institutional: {
    label: "Institutional",
    description: "Policy-based custody for treasury, settlement, and multi-party approval flows.",
  },
};

export type KnownCustodyProvider = CustodyProvider;

export interface CustodyProviderCatalogEntry {
  id: KnownCustodyProvider;
  label: string;
  description: string;
  category: WalletProviderCategory;
  supportsAdditionalWallets: boolean;
  supportsSigning: boolean;
  capabilities: readonly string[];
}

type CustodyProviderCatalogById = {
  [Provider in KnownCustodyProvider]: CustodyProviderCatalogEntry & { id: Provider };
};

const CUSTODY_PROVIDER_CATALOG_BY_ID = {
  local: {
    id: "local",
    label: "Local Signer",
    description: "Self-hosted Ed25519 keypair signer from CUSTODY_PRIVATE_KEY.",
    category: "server",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("local"),
    supportsSigning: providerSupportsSigning("local"),
    capabilities: ["Issuance", "Transfers"],
  },
  privy: {
    id: "privy",
    label: "Privy",
    description: "Hosted wallet infrastructure for API signing.",
    category: "server",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("privy"),
    supportsSigning: providerSupportsSigning("privy"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  fireblocks: {
    id: "fireblocks",
    label: "Fireblocks",
    description: "MPC custody with vault-based wallet controls.",
    category: "institutional",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("fireblocks"),
    supportsSigning: providerSupportsSigning("fireblocks"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  coinbase_cdp: {
    id: "coinbase_cdp",
    label: "Coinbase CDP",
    description: "Programmatic wallet provisioning through Coinbase CDP.",
    category: "server",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("coinbase_cdp"),
    supportsSigning: providerSupportsSigning("coinbase_cdp"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  para: {
    id: "para",
    label: "Para",
    description: "Embedded wallet custody for organization-level operations.",
    category: "server",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("para"),
    supportsSigning: providerSupportsSigning("para"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  turnkey: {
    id: "turnkey",
    label: "Turnkey",
    description: "Policy-based key custody for production signing workloads.",
    category: "server",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("turnkey"),
    supportsSigning: providerSupportsSigning("turnkey"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  dfns: {
    id: "dfns",
    label: "DFNS",
    description: "MPC wallet orchestration with secure API-driven signing.",
    category: "institutional",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("dfns"),
    supportsSigning: providerSupportsSigning("dfns"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  ibm_haven: {
    id: "ibm_haven",
    label: "IBM Digital Asset Haven",
    description: "Institutional custody on IBM Digital Asset Haven.",
    category: "institutional",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("ibm_haven"),
    supportsSigning: providerSupportsSigning("ibm_haven"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  anchorage: {
    id: "anchorage",
    label: "Anchorage",
    description: "Institutional custody with wallet lifecycle management.",
    category: "institutional",
    capabilities: ["Transfers", "Compliance"],
    supportsAdditionalWallets: providerSupportsAdditionalWallets("anchorage"),
    supportsSigning: providerSupportsSigning("anchorage"),
  },
  utila: {
    id: "utila",
    label: "Utila",
    description: "Vault-backed Solana wallet signing through Utila service accounts.",
    category: "institutional",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("utila"),
    supportsSigning: providerSupportsSigning("utila"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
} satisfies CustodyProviderCatalogById;

export const CUSTODY_PROVIDER_CATALOG: CustodyProviderCatalogEntry[] = Object.values(
  CUSTODY_PROVIDER_CATALOG_BY_ID
);

function getSharedProviderCapabilities(
  provider: KnownCustodyProvider
): CustodyProviderCapabilities {
  return CUSTODY_PROVIDER_CAPABILITIES[provider];
}

export function providerSupportsAdditionalWallets(provider: KnownCustodyProvider): boolean {
  return getSharedProviderCapabilities(provider).supportsAdditionalWalletCreation;
}

export function providerSupportsSigning(provider: KnownCustodyProvider): boolean {
  return getSharedProviderCapabilities(provider).supportsSigning;
}

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
  return CUSTODY_PROVIDER_CATALOG_BY_ID[provider];
}

export function getCustodyProviderCategory(provider: KnownCustodyProvider): WalletProviderCategory {
  return getCustodyProviderEntry(provider).category;
}

export function getCustodyProvidersByCategory(
  category: WalletProviderCategory
): CustodyProviderCatalogEntry[] {
  return CUSTODY_PROVIDER_CATALOG.filter((provider) => provider.category === category);
}
