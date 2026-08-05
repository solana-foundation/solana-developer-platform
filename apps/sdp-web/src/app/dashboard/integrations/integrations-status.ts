import type {
  ComplianceProviderId,
  OrganizationRpcProvider,
  ProviderAvailabilityEntry,
  RampProviderId,
} from "@sdp/types";
import { COMPLIANCE_PROVIDERS, ORGANIZATION_RPC_PROVIDERS, RAMP_PROVIDERS } from "@sdp/types";
import type { KnownCustodyProvider } from "@/app/dashboard/custody/provider-catalog";
import {
  type CustodyProviderAvailability,
  resolveCustodyProviderAvailability,
} from "@/app/dashboard/custody/provider-display-status";

/**
 * One vocabulary across every provider family, matching the custody setup step:
 * `active` is installed and working, `available` can be set up from here,
 * `request_access` is gated behind a conversation, `unavailable` is visible so
 * the catalog is honest about what exists, with no action attached.
 */
export type IntegrationStatus =
  | "active"
  | "available"
  | "pending"
  | "request_access"
  | "unavailable";

export interface IntegrationEntry<TProvider extends string = string> {
  provider: TProvider;
  label: string;
  status: IntegrationStatus;
}

/** Display labels for families whose ids never had UI names on main. */
export const RPC_PROVIDER_LABELS: Record<OrganizationRpcProvider, string> = {
  alchemy: "Alchemy",
  default: "SDP RPC",
  helius: "Helius",
  nodit: "Nodit",
  quicknode: "QuickNode",
  triton: "Triton",
  validationcloud: "Validation Cloud",
};

export const RAMP_PROVIDER_LABELS: Record<RampProviderId, string> = {
  moonpay: "MoonPay",
  lightspark: "Lightspark",
  bvnk: "BVNK",
  moneygram: "MoneyGram",
  coinbase: "Coinbase",
  mural: "Mural",
  stripe: "Stripe",
};

export const COMPLIANCE_PROVIDER_LABELS: Record<ComplianceProviderId, string> = {
  range: "Range",
  elliptic: "Elliptic",
  trm: "TRM Labs",
  chainalysis: "Chainalysis",
};

export function resolveCustodyIntegrations(input: {
  connectedProviders: readonly KnownCustodyProvider[];
  enabledProviders: readonly KnownCustodyProvider[];
}): CustodyProviderAvailability[] {
  return resolveCustodyProviderAvailability(input);
}

/**
 * The organization runs exactly one RPC provider, chosen in onboarding or
 * Settings — that one is active. The rest of the enabled set is available to
 * switch to; `default` is SDP's own key and is only worth naming while it is
 * what the organization actually uses.
 */
export function resolveRpcIntegrations(input: {
  selectedProvider: OrganizationRpcProvider | null;
  entries: Partial<Record<OrganizationRpcProvider, ProviderAvailabilityEntry>>;
}): IntegrationEntry<OrganizationRpcProvider>[] {
  return ORGANIZATION_RPC_PROVIDERS.filter(
    (provider) => provider !== "default" || input.selectedProvider === "default"
  ).map((provider) => {
    const entry = input.entries[provider];
    const status: IntegrationStatus =
      provider === input.selectedProvider ? "active" : entry?.enabled ? "available" : "unavailable";
    return { provider, label: RPC_PROVIDER_LABELS[provider], status };
  });
}

function entitledEntryStatus(entry: ProviderAvailabilityEntry | undefined): IntegrationStatus {
  if (!entry?.entitled) {
    return "unavailable";
  }
  if (entry.configured && entry.enabled) {
    return "active";
  }
  // Entitled but not runnable from the dashboard: these families are
  // provisioned by deployment configuration, not self-serve setup, so there is
  // no install action to offer yet.
  return "unavailable";
}

export function resolveRampIntegrations(
  entries: Partial<Record<RampProviderId, ProviderAvailabilityEntry>>
): IntegrationEntry<RampProviderId>[] {
  return RAMP_PROVIDERS.map((provider) => ({
    provider,
    label: RAMP_PROVIDER_LABELS[provider],
    status: entitledEntryStatus(entries[provider]),
  }));
}

export function resolveComplianceIntegrations(
  entries: Partial<Record<ComplianceProviderId, ProviderAvailabilityEntry>>
): IntegrationEntry<ComplianceProviderId>[] {
  return COMPLIANCE_PROVIDERS.map((provider) => ({
    provider,
    label: COMPLIANCE_PROVIDER_LABELS[provider],
    status: entitledEntryStatus(entries[provider]),
  }));
}
