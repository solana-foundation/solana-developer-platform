import type { RampProviderId } from "@sdp/types";
import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import type { LucideIcon } from "lucide-react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { getBvnkOnboardingCopy, getBvnkProvisioningDetail, getBvnkSimulateLabels } from "./bvnk";
import {
  getLightsparkOnboardingCopy,
  getLightsparkProvisioningDetail,
  getLightsparkSimulateLabels,
} from "./lightspark";
import {
  getMuralOnboardingCopy,
  getMuralProvisioningDetail,
  getMuralSimulateLabels,
} from "./mural";

export interface OnboardingCopy {
  title: string;
  description: string;
  icon: LucideIcon;
  iconClassName: string;
}

type BvnkRequirements = Extract<CounterpartyRequirements, { provider: "bvnk" }>;
type LightsparkRequirements = Extract<CounterpartyRequirements, { provider: "lightspark" }>;
type MuralRequirements = Extract<CounterpartyRequirements, { provider: "mural" }>;
type ReadyRequirement = Extract<CounterpartyRequirements, { status: "ready" }>;

export type BvnkOnboardingPanelStatus = Exclude<
  BvnkRequirements["status"] | ReadyRequirement["status"],
  "collect" | "collect_counterparty" | "customer_agreement_required" | "unsupported"
>;
export type LightsparkOnboardingPanelStatus = Exclude<
  LightsparkRequirements["status"] | ReadyRequirement["status"],
  "collect" | "collect_counterparty" | "collect_account" | "onboarding_not_started" | "unsupported"
>;
export type MuralOnboardingPanelStatus = Exclude<
  MuralRequirements["status"] | ReadyRequirement["status"],
  "collect" | "onboarding_not_started" | "unsupported"
>;

type BvnkPanelOnboardingRequirements =
  | Extract<CounterpartyRequirements, { provider: "bvnk"; status: BvnkOnboardingPanelStatus }>
  | (ReadyRequirement & { provider: "bvnk" });
type LightsparkPanelOnboardingRequirements =
  | Extract<
      CounterpartyRequirements,
      { provider: "lightspark"; status: LightsparkOnboardingPanelStatus }
    >
  | (ReadyRequirement & { provider: "lightspark" });
type MuralPanelOnboardingRequirements =
  | Extract<CounterpartyRequirements, { provider: "mural"; status: MuralOnboardingPanelStatus }>
  | (ReadyRequirement & { provider: "mural" });
type PanelOnboardingRequirements =
  | BvnkPanelOnboardingRequirements
  | LightsparkPanelOnboardingRequirements
  | MuralPanelOnboardingRequirements;

const BVNK_ONBOARDING_PANEL_STATUSES = new Set<BvnkOnboardingPanelStatus>([
  "customer_pending_agreement_acceptance",
  "customer_verification_required",
  "customer_verifying",
  "customer_verification_failed",
  "customer_funding_account_provisioning",
  "customer_funding_account_provisioning_failed",
  "ready",
]);

const LIGHTSPARK_ONBOARDING_PANEL_STATUSES = new Set<LightsparkOnboardingPanelStatus>(["ready"]);

const MURAL_ONBOARDING_PANEL_STATUSES = new Set<MuralOnboardingPanelStatus>([
  "terms_of_service_required",
  "customer_verification_required",
  "customer_verifying",
  "customer_verification_failed",
  "funding_account_provisioning",
  "ready",
]);

/**
 * Whether a requirements status is an onboarding-lifecycle state the panel can
 * render, as opposed to a form-collection or terminal-block state.
 *
 * @param requirements - Requirements result from the last advance.
 * @returns True when the onboarding panel has copy for the status.
 */
export function isOnboardingPanelStatus(
  requirements: CounterpartyRequirements
): requirements is PanelOnboardingRequirements {
  switch (requirements.provider) {
    case "bvnk":
      return BVNK_ONBOARDING_PANEL_STATUSES.has(requirements.status as BvnkOnboardingPanelStatus);
    case "lightspark":
      return LIGHTSPARK_ONBOARDING_PANEL_STATUSES.has(
        requirements.status as LightsparkOnboardingPanelStatus
      );
    case "mural":
      return MURAL_ONBOARDING_PANEL_STATUSES.has(requirements.status as MuralOnboardingPanelStatus);
    default:
      return false;
  }
}

export interface SimulateActionLabels {
  idle: string;
  busy: string;
  done: string;
}

type Translate = (key: MessageKey, values?: TranslationValues) => string;

/**
 * Providers with a counterparty onboarding/provisioning lifecycle (and thus panel copy).
 * Widget providers (moonpay, moneygram) report `ready` and go straight to a quote — they
 * never render the onboarding panel, so callers must gate on this before rendering it.
 */
export function hasOnboardingLifecycle(provider: RampProviderId): boolean {
  return provider === "bvnk" || provider === "lightspark" || provider === "mural";
}

/**
 * Resolves the copy for a provider-specific onboarding panel state.
 *
 * @param onboarding - Panel-eligible provider requirements.
 * @param t - Translation function for the active locale.
 * @returns The localized onboarding copy and icon presentation.
 */
export function onboardingCopy(
  onboarding: PanelOnboardingRequirements,
  t: Translate
): OnboardingCopy {
  switch (onboarding.provider) {
    case "bvnk":
      return getBvnkOnboardingCopy(t)[onboarding.status];
    case "lightspark":
      return getLightsparkOnboardingCopy(t)[onboarding.status];
    case "mural":
      return getMuralOnboardingCopy(t)[onboarding.status];
  }
  const exhaustive: never = onboarding;
  throw new Error(`No onboarding copy for ramp provider: ${String(exhaustive)}`);
}

/** Sandbox simulate-action labels for providers that support the simulate flow; null otherwise (caller hides the action). */
export function simulateActionLabels(
  provider: RampProviderId,
  t: Translate
): SimulateActionLabels | null {
  switch (provider) {
    case "bvnk":
      return getBvnkSimulateLabels(t);
    case "lightspark":
      return getLightsparkSimulateLabels(t);
    case "mural":
      return getMuralSimulateLabels(t);
    default:
      return null;
  }
}

/** One-line "what we're setting up under the hood" — varies by provider and direction. */
export function provisioningDetail(
  provider: RampProviderId,
  direction: RampDirection,
  t: Translate
): string {
  switch (provider) {
    case "bvnk":
      return getBvnkProvisioningDetail(t)[direction];
    case "lightspark":
      return getLightsparkProvisioningDetail(t)[direction];
    case "mural":
      return getMuralProvisioningDetail(t)[direction];
    default:
      throw new Error(`No provisioning detail for ramp provider: ${provider}`);
  }
}
