import type { RampProviderId } from "@sdp/types";
import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";
import type { LucideIcon } from "lucide-react";
import type { SandboxTransferSimulationInput } from "@/app/dashboard/payments/payments-workspace.data";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { getBvnkOnboardingCopy, getBvnkProvisioningDetail, getBvnkSimulateLabels } from "./bvnk";
import {
  getHercleOnboardingCopy,
  getHercleProvisioningDetail,
  getHercleSimulateLabels,
  hercleOfframpSettlementSimulation,
} from "./hercle";
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
  "collect" | "collect_counterparty" | "collect_account" | "unsupported" | "onboarding_not_started"
>;

/**
 * Whether a requirements status is an onboarding-lifecycle state the panel can
 * render, as opposed to a form-collection or terminal-block state.
 *
 * @param status - Requirements status from the last advance.
 * @returns True when the onboarding panel has copy for the status.
 */
export function isOnboardingPanelStatus(
  status: CounterpartyRequirements["status"]
): status is OnboardingPanelStatus {
  switch (status) {
    case "collect":
    case "collect_counterparty":
    case "collect_account":
    case "unsupported":
    case "onboarding_not_started":
      return false;
    default:
      return true;
  }
}
export type StandardOnboardingPanelStatus = Exclude<
  OnboardingPanelStatus,
  "terms_of_service_required"
>;
export type MuralOnboardingPanelStatus = Exclude<OnboardingPanelStatus, "provisioning_failed">;
/** Hercle's only provisioning wait is the bank rail registering the business's payout account. */
export type HercleOnboardingPanelStatus = Exclude<
  OnboardingPanelStatus,
  "terms_of_service_required" | "provisioning_failed"
>;

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
  return (
    provider === "bvnk" ||
    provider === "lightspark" ||
    provider === "mural" ||
    provider === "hercle"
  );
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
    case "hercle": {
      if (
        status === "terms_of_service_required" ||
        status === "funding_account_provisioning" ||
        status === "provisioning_failed"
      ) {
        throw new Error(`No onboarding copy for ramp provider/status: ${provider}/${status}`);
      }
      return getHercleOnboardingCopy(t)[status];
    }
    default:
      throw new Error(`No onboarding copy for ramp provider: ${provider}`);
  }
}

/**
 * Sandbox settlement simulation for an off-ramp order, for providers that expose one; null
 * otherwise (caller hides the action). Most providers only simulate the pay-in leg, which
 * belongs to the on-ramp arm.
 */
export function offrampSettlementSimulation(
  provider: RampProviderId,
  orderId: string
): SandboxTransferSimulationInput | null {
  switch (provider) {
    case "hercle":
      return hercleOfframpSettlementSimulation(orderId);
    default:
      return null;
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
    case "hercle":
      return getHercleSimulateLabels(t);
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
    case "hercle":
      return getHercleProvisioningDetail(t)[direction];
    default:
      throw new Error(`No provisioning detail for ramp provider: ${provider}`);
  }
}
