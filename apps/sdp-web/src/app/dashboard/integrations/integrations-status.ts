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
import type { MessageKey } from "@/i18n/messages";
import { RPC_PROVIDER_LABELS } from "@/lib/rpc-providers";

/**
 * One vocabulary across every provider family, aligned with the
 * remove-signup-waitlist decision map. Every provider this catalog lists is
 * built and runnable, so a status only ever answers "what is my next step":
 *
 * - `active` — running for this organization now. Only families that hold a
 *   real per-organization link (a custody connection, the selected RPC) may
 *   report it; a deployment-wide rail is never "connected" to anyone.
 * - `available` — the organization can use or set this up from here.
 * - `enabled` — a deployment-wide rail (ramps, compliance) that is on for this
 *   organization; there is nothing to connect.
 * - `request_access` — organization access the SDP team grants (HOO-772/775).
 *   For custody this is only shown when the catalog carries an actual request
 *   route: the state is a promise of a way to ask, not just a classification.
 * - `not_configured` — environment availability: this deployment does not hold
 *   the provider's credentials, and never phrased as organization access
 *   (decision-map.md #4). Manual custody providers without a wired request
 *   route also hold here until HOO-775 gives each one a real route.
 *
 * Nothing here may imply a provider does not exist — the row is the claim
 * that it does.
 */
export type IntegrationStatus =
  | "active"
  | "available"
  | "enabled"
  | "request_access"
  | "not_configured"
  | "unknown";

export type PrivacyProviderId = "private-channels";

export interface IntegrationEntry<TProvider extends string = string> {
  provider: TProvider;
  label: string;
  status: IntegrationStatus;
  descriptionKey?: MessageKey;
}

const RPC_DESCRIPTION_KEYS: Record<OrganizationRpcProvider, MessageKey> = {
  alchemy: "DashboardCustody.onboardingRpcAlchemyDescription",
  default: "DashboardCustody.onboardingRpcDefaultDescription",
  helius: "DashboardCustody.onboardingRpcHeliusDescription",
  nodit: "DashboardCustody.onboardingRpcNoditDescription",
  quicknode: "DashboardCustody.onboardingRpcQuickNodeDescription",
  triton: "DashboardCustody.onboardingRpcTritonDescription",
  validationcloud: "DashboardCustody.onboardingRpcValidationCloudDescription",
};

const RAMP_DESCRIPTION_KEYS: Record<RampProviderId, MessageKey> = {
  moonpay: "Shared.integrations.rampMoonpayDescription",
  lightspark: "Shared.integrations.rampLightsparkDescription",
  bvnk: "Shared.integrations.rampBvnkDescription",
  moneygram: "Shared.integrations.rampMoneygramDescription",
  coinbase: "Shared.integrations.rampCoinbaseDescription",
  mural: "Shared.integrations.rampMuralDescription",
  stripe: "Shared.integrations.rampStripeDescription",
};

const COMPLIANCE_DESCRIPTION_KEYS: Record<ComplianceProviderId, MessageKey> = {
  range: "Shared.integrations.complianceRangeDescription",
  elliptic: "Shared.integrations.complianceEllipticDescription",
  trm: "Shared.integrations.complianceTrmDescription",
  chainalysis: "Shared.integrations.complianceChainalysisDescription",
};

/**
 * Re-exported so the catalog's consumers keep one import path now that the
 * labels are shared with Settings and the integration detail controls.
 */
export { RPC_PROVIDER_LABELS };

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
 * Which RPC provider is actually carrying this project's traffic — that one is
 * active, and the rest of the enabled set is available to switch to.
 *
 * A tenant connection outranks the organization's selection, because that is
 * the order the relay resolves in: it only reaches `organization_provider`
 * after tenant resolution returns nothing. Reading `active` off the selection
 * alone marked the provider a project had merely *picked* as Connected while
 * the provider its requests really went through read "Ready to connect" — the
 * two answers exactly inverted, on the catalog and on the detail header.
 *
 * A serving provider is active even when this deployment holds no URL for it:
 * BYOK runs on the tenant's own endpoint, so deployment availability decides
 * nothing about whether their own key is live.
 *
 * `default` is listed like any other provider, including while the organization
 * is on a vendor. Hiding it left an organization that had moved to Helius with
 * no page offering SDP RPC and a 404 at its route, so the only way back was the
 * Settings dropdown this family replaced (HOO-787).
 */
export function resolveRpcIntegrations(input: {
  selectedProvider: OrganizationRpcProvider | null;
  /**
   * The provider whose tenant-owned connection serves this project. `null` when
   * nothing of the tenant's own does — and also when the viewer may not read
   * connections at all, in which case the organization's selection is the best
   * answer available and the behaviour is unchanged from before BYOK.
   */
  servingProvider?: OrganizationRpcProvider | null;
  /**
   * Providers this project holds a live key of its own for. A tenant key runs
   * on the tenant's endpoint, so it makes a provider usable no matter what this
   * deployment holds — without this, a provider they had configured themselves
   * and could switch to read "Not configured" beside its own Use this provider
   * button.
   */
  providersWithOwnKey?: readonly string[];
  entries: Partial<Record<OrganizationRpcProvider, ProviderAvailabilityEntry>>;
}): IntegrationEntry<OrganizationRpcProvider>[] {
  const activeProvider = input.servingProvider ?? input.selectedProvider;
  const ownKeys = new Set(input.providersWithOwnKey ?? []);

  return ORGANIZATION_RPC_PROVIDERS.map((provider) => {
    const entry = input.entries[provider];
    // Every RPC provider is generally available; an unconfigured one lacks a
    // URL in this deployment *and* a key of the tenant's own, because either
    // one is enough to route through it. Deployment availability is never
    // organization access.
    const status: IntegrationStatus =
      provider === activeProvider
        ? "active"
        : entry?.enabled || ownKeys.has(provider)
          ? "available"
          : "not_configured";
    return {
      provider,
      label: RPC_PROVIDER_LABELS[provider],
      status,
      descriptionKey: RPC_DESCRIPTION_KEYS[provider],
    };
  });
}

/**
 * A deployment-wide rail is on or off; no organization ever connects one, so
 * these families never report `active`. All three flags, not just `enabled`:
 * the API derives it as entitled && configured, so anything less than
 * agreement between them is a payload we should not read a promise out of.
 */
function railIsOn(entry: ProviderAvailabilityEntry | undefined): boolean {
  return entry?.entitled === true && entry.configured && entry.enabled;
}

/** Every ramp is generally available; off means uncredentialed here, never gated. */
export function resolveRampIntegrations(
  entries: Partial<Record<RampProviderId, ProviderAvailabilityEntry>>
): IntegrationEntry<RampProviderId>[] {
  return RAMP_PROVIDERS.map((provider) => ({
    provider,
    label: RAMP_PROVIDER_LABELS[provider],
    status: railIsOn(entries[provider]) ? "enabled" : "not_configured",
    descriptionKey: RAMP_DESCRIPTION_KEYS[provider],
  }));
}

/**
 * Every compliance provider is manual: the SDP team activates it per
 * organization. Activated but uncredentialed is the one case where the
 * deployment, not access, is what is missing.
 */
export function resolveComplianceIntegrations(
  entries: Partial<Record<ComplianceProviderId, ProviderAvailabilityEntry>>
): IntegrationEntry<ComplianceProviderId>[] {
  return COMPLIANCE_PROVIDERS.map((provider) => {
    const entry = entries[provider];
    const status: IntegrationStatus = railIsOn(entry)
      ? "enabled"
      : entry?.entitled
        ? "not_configured"
        : "request_access";
    return {
      provider,
      label: COMPLIANCE_PROVIDER_LABELS[provider],
      status,
      descriptionKey: COMPLIANCE_DESCRIPTION_KEYS[provider],
    };
  });
}

/**
 * Private Channels keeps its existing deployment feature gate and project-scoped
 * instance. The catalog only needs the active instance read: no active row means
 * the integration is ready to configure, while a failed read must stay unknown.
 */
export function resolvePrivacyIntegrations(input: {
  enabled: boolean;
  active: boolean | null;
  label: string;
}): IntegrationEntry<PrivacyProviderId>[] {
  if (!input.enabled) return [];
  return [
    {
      provider: "private-channels",
      label: input.label,
      status: input.active === null ? "unknown" : input.active ? "active" : "available",
      descriptionKey: "Shared.integrations.privateChannelsDescription",
    },
  ];
}
