export const CUSTODY_FEATURES = ["Issuance", "Transfers", "Compliance"] as const;

export type KnownCustodyProvider =
  | "privy"
  | "fireblocks"
  | "coinbase_cdp"
  | "para"
  | "turnkey";

export interface CustodyProviderCatalogEntry {
  id: KnownCustodyProvider;
  label: string;
  description: string;
  supportsAdditionalWallets: boolean;
}

export const CUSTODY_PROVIDER_CATALOG: CustodyProviderCatalogEntry[] = [
  {
    id: "privy",
    label: "Privy",
    description: "Hosted wallet infrastructure for API signing.",
    supportsAdditionalWallets: true,
  },
  {
    id: "fireblocks",
    label: "Fireblocks",
    description: "MPC custody with vault-based wallet controls.",
    supportsAdditionalWallets: false,
  },
  {
    id: "coinbase_cdp",
    label: "Coinbase CDP",
    description: "Programmatic wallet provisioning through Coinbase CDP.",
    supportsAdditionalWallets: true,
  },
  {
    id: "para",
    label: "Para",
    description: "Embedded wallet custody for organization-level operations.",
    supportsAdditionalWallets: true,
  },
  {
    id: "turnkey",
    label: "Turnkey",
    description: "Policy-based key custody for production signing workloads.",
    supportsAdditionalWallets: true,
  },
];

const PROVIDER_LABELS = new Map(CUSTODY_PROVIDER_CATALOG.map((provider) => [provider.id, provider.label]));

const PROVIDER_SET = new Set<KnownCustodyProvider>(CUSTODY_PROVIDER_CATALOG.map((provider) => provider.id));

export function isKnownCustodyProvider(value: string): value is KnownCustodyProvider {
  return PROVIDER_SET.has(value as KnownCustodyProvider);
}

export function formatCustodyProviderName(provider: string): string {
  return PROVIDER_LABELS.get(provider as KnownCustodyProvider) ?? provider;
}
