import type { RampProviderId } from "@sdp/types";
import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import type { LucideIcon } from "lucide-react";
import { BVNK_ONBOARDING_COPY, BVNK_PROVISIONING_DETAIL, BVNK_SIMULATE_LABELS } from "./bvnk";
import {
  LIGHTSPARK_ONBOARDING_COPY,
  LIGHTSPARK_PROVISIONING_DETAIL,
  LIGHTSPARK_SIMULATE_LABELS,
} from "./lightspark";

export interface OnboardingCopy {
  title: string;
  description: string;
  icon: LucideIcon;
  iconClassName: string;
}

export type OnboardingPanelStatus = Exclude<
  CounterpartyRequirements["status"],
  "collect" | "unsupported" | "onboarding_not_started"
>;

export interface SimulateActionLabels {
  idle: string;
  busy: string;
  done: string;
}

/**
 * Providers with a counterparty onboarding/provisioning lifecycle (and thus panel copy).
 * Widget providers (moonpay, moneygram) report `ready` and go straight to a quote — they
 * never render the onboarding panel, so callers must gate on this before rendering it.
 */
export function hasOnboardingLifecycle(provider: RampProviderId): boolean {
  return provider === "bvnk" || provider === "lightspark";
}

export function onboardingCopy(
  provider: RampProviderId,
  status: OnboardingPanelStatus
): OnboardingCopy {
  switch (provider) {
    case "bvnk":
      return BVNK_ONBOARDING_COPY[status];
    case "lightspark":
      return LIGHTSPARK_ONBOARDING_COPY[status];
    default:
      throw new Error(`No onboarding copy for ramp provider: ${provider}`);
  }
}

/** Sandbox simulate-action labels for providers that support the simulate flow; null otherwise (caller hides the action). */
export function simulateActionLabels(provider: RampProviderId): SimulateActionLabels | null {
  switch (provider) {
    case "bvnk":
      return BVNK_SIMULATE_LABELS;
    case "lightspark":
      return LIGHTSPARK_SIMULATE_LABELS;
    default:
      return null;
  }
}

/** One-line "what we're setting up under the hood" — varies by provider and direction. */
export function provisioningDetail(provider: RampProviderId, direction: RampDirection): string {
  switch (provider) {
    case "bvnk":
      return BVNK_PROVISIONING_DETAIL[direction];
    case "lightspark":
      return LIGHTSPARK_PROVISIONING_DETAIL[direction];
    default:
      throw new Error(`No provisioning detail for ramp provider: ${provider}`);
  }
}
