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

export function simulateActionLabels(provider: "bvnk" | "lightspark"): SimulateActionLabels {
  return provider === "bvnk" ? BVNK_SIMULATE_LABELS : LIGHTSPARK_SIMULATE_LABELS;
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
