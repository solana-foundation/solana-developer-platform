import type { RampProviderId } from "@sdp/types";
import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import type { LucideIcon } from "lucide-react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { getBvnkOnboardingCopy, getBvnkProvisioningDetail, getBvnkSimulateLabels } from "./bvnk";

export interface OnboardingCopy {
  title: string;
  description: string;
  icon: LucideIcon;
  iconClassName: string;
}

type BvnkRequirements = Extract<CounterpartyRequirements, { provider: "bvnk" }>;
type ReadyRequirement = Extract<CounterpartyRequirements, { status: "ready" }>;

export type BvnkOnboardingPanelStatus = Exclude<
  BvnkRequirements["status"] | ReadyRequirement["status"],
  | "collect"
  | "collect_counterparty"
  | "collect_counterparty_residence"
  | "counterparty_collect_agreement"
  | "unsupported"
>;

type PanelOnboardingRequirements =
  | Extract<CounterpartyRequirements, { provider: "bvnk"; status: BvnkOnboardingPanelStatus }>
  | (ReadyRequirement & { provider: "bvnk" });

const BVNK_ONBOARDING_PANEL_STATUSES: ReadonlySet<CounterpartyRequirements["status"]> = new Set([
  "customer_verification_required",
  "customer_verifying",
  "counterparty_agreement_signing",
  "customer_verification_failed",
  "customer_funding_account_provisioning",
  "customer_funding_account_provisioning_failed",
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
  return (
    requirements.provider === "bvnk" && BVNK_ONBOARDING_PANEL_STATUSES.has(requirements.status)
  );
}

export interface SimulateActionLabels {
  idle: string;
  busy: string;
  done: string;
}

type Translate = (key: MessageKey, values?: TranslationValues) => string;

/**
 * Providers with a counterparty onboarding/provisioning lifecycle (and thus panel copy).
 * Widget providers (moonpay, stripe) report `ready` and go straight to a quote — they
 * never render the onboarding panel, so callers must gate on this before rendering it.
 */
export function hasOnboardingLifecycle(provider: RampProviderId): boolean {
  return provider === "bvnk";
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
  return getBvnkOnboardingCopy(t)[onboarding.status];
}

/** Sandbox simulate-action labels for providers that support the simulate flow; null otherwise (caller hides the action). */
export function simulateActionLabels(
  provider: RampProviderId,
  t: Translate
): SimulateActionLabels | null {
  switch (provider) {
    case "bvnk":
      return getBvnkSimulateLabels(t);
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
    default:
      throw new Error(`No provisioning detail for ramp provider: ${provider}`);
  }
}
