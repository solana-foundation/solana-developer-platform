import type { RampDirection } from "@sdp/types/ramp-requirements";
import { Loader2Icon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import type { SandboxTransferSimulationInput } from "@/app/dashboard/payments/payments-workspace.data";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import type { HercleOnboardingPanelStatus, OnboardingCopy, SimulateActionLabels } from "./index";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function getHercleOnboardingCopy(
  t: Translate
): Record<HercleOnboardingPanelStatus, OnboardingCopy> {
  return {
    customer_verification_required: {
      title: t("DashboardPayments.hercle.verificationRequiredTitle"),
      description: t("DashboardPayments.hercle.verificationRequiredDescription"),
      icon: ShieldCheckIcon,
      iconClassName: "text-primary",
    },
    customer_verifying: {
      title: t("DashboardPayments.hercle.verificationInReviewTitle"),
      description: t("DashboardPayments.hercle.verificationInReviewDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-secondary",
    },
    customer_verification_failed: {
      title: t("DashboardPayments.hercle.verificationFailedTitle"),
      description: t("DashboardPayments.hercle.verificationFailedDescription"),
      icon: XCircleIcon,
      iconClassName: "text-error",
    },
    funding_account_provisioning: {
      title: t("DashboardPayments.hercle.fundingAccountProvisioningTitle"),
      description: t("DashboardPayments.hercle.fundingAccountProvisioningDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-secondary",
    },
    ready: {
      title: t("DashboardPayments.hercle.readyTitle"),
      description: t("DashboardPayments.hercle.readyDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-secondary",
    },
  };
}

export function getHercleProvisioningDetail(t: Translate): Record<RampDirection, string> {
  return {
    onramp: t("DashboardPayments.hercle.onrampProvisioningDetail"),
    offramp: t("DashboardPayments.hercle.offrampProvisioningDetail"),
  };
}

/**
 * Off-ramp settlement simulation. The crypto is already on chain, but Hercle has no deposit
 * watcher yet, so the sandbox applies the outcome the chain would report and Hercle delivers
 * its normal signed settlement webhook — the event is the production one, only its trigger
 * is simulated.
 */
export function hercleOfframpSettlementSimulation(orderId: string): SandboxTransferSimulationInput {
  return { provider: "hercle", payload: { orderId, status: "settled" } };
}

export function getHercleSimulateLabels(t: Translate): SimulateActionLabels {
  return {
    idle: t("DashboardPayments.hercle.simulateDeposit"),
    busy: t("DashboardPayments.hercle.simulating"),
    done: t("DashboardPayments.hercle.depositSimulated"),
  };
}
