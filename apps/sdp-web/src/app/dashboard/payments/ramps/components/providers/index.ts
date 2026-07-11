import type { RampProviderId } from "@sdp/types";
import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import type { LucideIcon } from "lucide-react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import {
  getBvnkOnboardingCopy,
  getBvnkProvisioningDetail,
  getBvnkSimulateLabels,
} from "./bvnk";
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

export type OnboardingPanelStatus = Exclude<
  CounterpartyRequirements["status"],
  "collect" | "unsupported" | "onboarding_not_started"
>;
export type StandardOnboardingPanelStatus = Exclude<
  OnboardingPanelStatus,
  "terms_of_service_required"
>;
export type MuralOnboardingPanelStatus = Exclude<OnboardingPanelStatus, "provisioning_failed">;

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

export function onboardingCopy(
  provider: RampProviderId,
  status: OnboardingPanelStatus,
  t: Translate
): OnboardingCopy {
  switch (provider) {
    case "bvnk": {
      if (status === "terms_of_service_required") {
        throw new Error(`No onboarding copy for ramp provider/status: ${provider}/${status}`);
      }
      return getBvnkOnboardingCopy(t)[status];
    }
    case "lightspark": {
      if (status === "terms_of_service_required") {
        throw new Error(`No onboarding copy for ramp provider/status: ${provider}/${status}`);
      }
      return getLightsparkOnboardingCopy(t)[status];
    }
    case "mural": {
      if (status === "provisioning_failed") {
        throw new Error(`No onboarding copy for ramp provider/status: ${provider}/${status}`);
      }
      return getMuralOnboardingCopy(t)[status];
    }
    default:
      throw new Error(`No onboarding copy for ramp provider: ${provider}`);
  }
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
