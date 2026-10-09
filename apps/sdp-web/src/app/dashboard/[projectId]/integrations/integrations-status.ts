import type { ComplianceProviderId, RampProviderId } from "@sdp/types";
import type { KnownCustodyProvider } from "@/app/dashboard/[projectId]/custody/provider-catalog";
import {
  type CustodyProviderAvailability,
  resolveCustodyProviderAvailability,
} from "@/app/dashboard/[projectId]/custody/provider-display-status";
import type { MessageKey } from "@/i18n/messages";
import type { ProjectCustodyAvailability } from "@/lib/provider-availability";

/**
 * One vocabulary across every provider family. The catalog lists only the
 * providers the project can use (the project provider-availability read), so
 * a status only ever answers "what is my next step":
 *
 * - `active` — running for this project now. Only families that hold a real
 *   per-project link (a custody config, an active Private Channels instance)
 *   may report it; a deployment-wide rail is never "connected" to anyone.
 * - `available` — the project can set this up from here.
 * - `enabled` — a deployment-wide rail (ramps, compliance) the project can
 *   use; there is nothing to connect.
 * - `unknown` — the state could not be read.
 *
 * A provider the project cannot use is hidden, not given a status.
 */
export type IntegrationStatus = "active" | "available" | "enabled" | "unknown";

export type PrivacyProviderId = "private-channels";

export interface IntegrationEntry<TProvider extends string = string> {
  provider: TProvider;
  label: string;
  status: IntegrationStatus;
  descriptionKey?: MessageKey;
}

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

/**
 * The custody providers the project can use, with their setup status.
 *
 * @param input - The project's custody state.
 * @param input.connectedProviders - Providers with an active custody config in the project.
 * @param input.custodyAvailability - The project's custody provider availability entries.
 * @returns One row per custody provider the project can use.
 */
export function resolveCustodyIntegrations(input: {
  connectedProviders: readonly KnownCustodyProvider[];
  custodyAvailability: readonly ProjectCustodyAvailability[];
}): CustodyProviderAvailability[] {
  return resolveCustodyProviderAvailability(input);
}

/**
 * A deployment-wide rail is on or off; no project ever connects one, so these
 * families never report `active`.
 *
 * @param availableProviders - The ramp providers the project can use.
 * @param offeredProviders - The providers offered (`getOfferedRampProviders`), in canonical order.
 * @returns One `enabled` entry per offered ramp provider the project can use.
 */
export function resolveRampIntegrations(
  availableProviders: readonly RampProviderId[],
  offeredProviders: readonly RampProviderId[]
): IntegrationEntry<RampProviderId>[] {
  return offeredProviders
    .filter((provider) => availableProviders.includes(provider))
    .map((provider) => ({
      provider,
      label: RAMP_PROVIDER_LABELS[provider],
      status: "enabled",
      descriptionKey: RAMP_DESCRIPTION_KEYS[provider],
    }));
}

/**
 * Compliance providers are deployment-wide rails the SDP team activates per
 * organization; the project lists the ones it can use.
 *
 * @param availableProviders - The compliance providers the project can use.
 * @returns One `enabled` entry per available compliance provider.
 */
export function resolveComplianceIntegrations(
  availableProviders: readonly ComplianceProviderId[]
): IntegrationEntry<ComplianceProviderId>[] {
  return availableProviders.map((provider) => ({
    provider,
    label: COMPLIANCE_PROVIDER_LABELS[provider],
    status: "enabled",
    descriptionKey: COMPLIANCE_DESCRIPTION_KEYS[provider],
  }));
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
