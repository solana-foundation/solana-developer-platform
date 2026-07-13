import type { RampDirection } from "@sdp/types/ramp-requirements";
import { Loader2Icon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import type { OnboardingCopy, SimulateActionLabels, StandardOnboardingPanelStatus } from "./index";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function getBvnkOnboardingCopy(
  t: Translate
): Record<StandardOnboardingPanelStatus, OnboardingCopy> {
  return {
    customer_verification_required: {
      title: t("DashboardPayments.bvnk.verificationRequiredTitle"),
      description: t("DashboardPayments.bvnk.verificationRequiredDescription"),
      icon: ShieldCheckIcon,
      iconClassName: "text-primary",
    },
    customer_verifying: {
      title: t("DashboardPayments.bvnk.verificationInReviewTitle"),
      description: t("DashboardPayments.bvnk.verificationInReviewDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-secondary",
    },
    customer_verification_failed: {
      title: t("DashboardPayments.bvnk.verificationFailedTitle"),
      description: t("DashboardPayments.bvnk.verificationFailedDescription"),
      icon: XCircleIcon,
      iconClassName: "text-error",
    },
    funding_account_provisioning: {
      title: t("DashboardPayments.bvnk.fundingAccountProvisioningTitle"),
      description: t("DashboardPayments.bvnk.fundingAccountProvisioningDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-secondary",
    },
    provisioning_failed: {
      title: t("DashboardPayments.bvnk.provisioningFailedTitle"),
      description: t("DashboardPayments.bvnk.provisioningFailedDescription"),
      icon: XCircleIcon,
      iconClassName: "text-error",
    },
    ready: {
      title: t("DashboardPayments.bvnk.readyTitle"),
      description: t("DashboardPayments.bvnk.readyDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-secondary",
    },
  };
}

export function getBvnkProvisioningDetail(t: Translate): Record<RampDirection, string> {
  return {
    onramp: t("DashboardPayments.bvnk.onrampProvisioningDetail"),
    offramp: t("DashboardPayments.bvnk.offrampProvisioningDetail"),
  };
}

export function getBvnkSimulateLabels(t: Translate): SimulateActionLabels {
  return {
    idle: t("DashboardPayments.bvnk.simulateDeposit"),
    busy: t("DashboardPayments.bvnk.simulating"),
    done: t("DashboardPayments.bvnk.depositSimulated"),
  };
}
