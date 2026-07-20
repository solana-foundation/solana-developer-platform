import {
  CUSTODY_PROVIDER_CATALOG as SHARED_CUSTODY_PROVIDER_CATALOG,
  CUSTODY_PROVIDER_CATEGORIES,
  CUSTODY_PROVIDER_CATEGORY_DETAILS,
  CUSTODY_PROVIDER_CAPABILITIES,
  CUSTODY_PROVIDER_USE_CASE_LABEL_KEYS,
  type CustodyProvider,
  type CustodyProviderCategory,
  type CustodyProviderCapabilities,
  type CustodyProviderSetupField,
  type CustodyProviderSetupFieldOption,
  type CustodyProviderUseCase,
} from "@sdp/types";
import type { MessageKey } from "@/i18n/messages";

export {
  CUSTODY_PROVIDER_DISPLAY_STATUSES,
  type CustodyProviderDisplayStatus,
} from "@sdp/types";

export const CUSTODY_CAPABILITY_LABEL_KEYS: Record<CustodyProviderUseCase, MessageKey> =
  CUSTODY_PROVIDER_USE_CASE_LABEL_KEYS;

export const WALLET_PROVIDER_CATEGORIES = CUSTODY_PROVIDER_CATEGORIES;
export type WalletProviderCategory = CustodyProviderCategory;

export const WALLET_PROVIDER_CATEGORY_DETAILS: Record<
  WalletProviderCategory,
  {
    labelKey: MessageKey;
    descriptionKey: MessageKey;
  }
> = CUSTODY_PROVIDER_CATEGORY_DETAILS;

export type KnownCustodyProvider = CustodyProvider;

type DashboardCustodyProviderSetupField = CustodyProviderSetupField & {
  labelKey: MessageKey;
  helpTextKey: MessageKey;
  options?: readonly (CustodyProviderSetupFieldOption & { labelKey: MessageKey })[];
};

type DashboardCustodyProviderStoredCredentialSetup =
  | { mode: "self_service"; fields: readonly DashboardCustodyProviderSetupField[] }
  | { mode: "request_access"; requestAccessUrl: string }
  | { mode: "unavailable" };

export interface CustodyProviderCatalogEntry {
  id: KnownCustodyProvider;
  label: string;
  descriptionKey: MessageKey;
  category: WalletProviderCategory;
  visible: boolean;
  technicalCapabilities: CustodyProviderCapabilities;
  useCases: readonly CustodyProviderUseCase[];
  storedCredentialSetup: DashboardCustodyProviderStoredCredentialSetup;
  supportsAdditionalWallets: boolean;
  supportsSigning: boolean;
  capabilities: readonly CustodyProviderUseCase[];
}

export const CUSTODY_PROVIDER_CATALOG: CustodyProviderCatalogEntry[] =
  SHARED_CUSTODY_PROVIDER_CATALOG.map((provider) => ({
    ...provider,
    supportsAdditionalWallets:
      provider.technicalCapabilities.supportsAdditionalWalletCreation,
    supportsSigning: provider.technicalCapabilities.supportsSigning,
    capabilities: provider.useCases,
  }));

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

const PROVIDER_CATALOG_BY_ID = new Map(
  CUSTODY_PROVIDER_CATALOG.map((provider) => [provider.id, provider])
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
  return PROVIDER_CATALOG_BY_ID.get(provider)!;
}

export function getCustodyProviderCategory(provider: KnownCustodyProvider): WalletProviderCategory {
  return getCustodyProviderEntry(provider).category;
}

export function getCustodyProvidersByCategory(
  category: WalletProviderCategory
): CustodyProviderCatalogEntry[] {
  return CUSTODY_PROVIDER_CATALOG.filter((provider) => provider.category === category);
}
