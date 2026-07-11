import {
  CUSTODY_PROVIDER_CAPABILITIES,
  type CustodyProvider,
  type CustodyProviderCapabilities,
} from "@sdp/types";
import type { MessageKey } from "@/i18n/messages";

const DEFAULT_CUSTODY_CAPABILITIES = ["Issuance", "Transfers", "Compliance"] as const;

export const WALLET_PROVIDER_CATEGORIES = ["server", "institutional"] as const;
export type WalletProviderCategory = (typeof WALLET_PROVIDER_CATEGORIES)[number];

export const WALLET_PROVIDER_CATEGORY_DETAILS: Record<
  WalletProviderCategory,
  {
    labelKey: MessageKey;
    descriptionKey: MessageKey;
  }
> = {
  server: {
    labelKey: "DashboardCustody.providerCategoryApi",
    descriptionKey: "DashboardCustody.providerCategoryApiDescription",
  },
  institutional: {
    labelKey: "DashboardCustody.providerCategoryInstitutional",
    descriptionKey: "DashboardCustody.providerCategoryInstitutionalDescription",
  },
};

export type KnownCustodyProvider = CustodyProvider;

export interface CustodyProviderCatalogEntry {
  id: KnownCustodyProvider;
  label: string;
  descriptionKey: MessageKey;
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
    descriptionKey: "DashboardCustody.providerLocalDescription",
    category: "server",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("local"),
    supportsSigning: providerSupportsSigning("local"),
    capabilities: ["Issuance", "Transfers"],
  },
  privy: {
    id: "privy",
    label: "Privy",
    descriptionKey: "DashboardCustody.providerPrivyDescription",
    category: "server",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("privy"),
    supportsSigning: providerSupportsSigning("privy"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  fireblocks: {
    id: "fireblocks",
    label: "Fireblocks",
    descriptionKey: "DashboardCustody.providerFireblocksDescription",
    category: "institutional",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("fireblocks"),
    supportsSigning: providerSupportsSigning("fireblocks"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  coinbase_cdp: {
    id: "coinbase_cdp",
    label: "Coinbase CDP",
    descriptionKey: "DashboardCustody.providerCoinbaseCdpDescription",
    category: "server",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("coinbase_cdp"),
    supportsSigning: providerSupportsSigning("coinbase_cdp"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  para: {
    id: "para",
    label: "Para",
    descriptionKey: "DashboardCustody.providerParaDescription",
    category: "server",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("para"),
    supportsSigning: providerSupportsSigning("para"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  turnkey: {
    id: "turnkey",
    label: "Turnkey",
    descriptionKey: "DashboardCustody.providerTurnkeyDescription",
    category: "server",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("turnkey"),
    supportsSigning: providerSupportsSigning("turnkey"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  dfns: {
    id: "dfns",
    label: "DFNS",
    descriptionKey: "DashboardCustody.providerDfnsDescription",
    category: "institutional",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("dfns"),
    supportsSigning: providerSupportsSigning("dfns"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  ibm_haven: {
    id: "ibm_haven",
    label: "IBM Digital Asset Haven",
    descriptionKey: "DashboardCustody.providerIbmHavenDescription",
    category: "institutional",
    supportsAdditionalWallets: providerSupportsAdditionalWallets("ibm_haven"),
    supportsSigning: providerSupportsSigning("ibm_haven"),
    capabilities: DEFAULT_CUSTODY_CAPABILITIES,
  },
  anchorage: {
    id: "anchorage",
    label: "Anchorage",
    descriptionKey: "DashboardCustody.providerAnchorageDescription",
    category: "institutional",
    capabilities: ["Transfers", "Compliance"],
    supportsAdditionalWallets: providerSupportsAdditionalWallets("anchorage"),
    supportsSigning: providerSupportsSigning("anchorage"),
  },
  utila: {
    id: "utila",
    label: "Utila",
    descriptionKey: "DashboardCustody.providerUtilaDescription",
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
