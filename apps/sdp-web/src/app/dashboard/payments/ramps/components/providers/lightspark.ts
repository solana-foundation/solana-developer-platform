import type { RampDirection } from "@sdp/types/ramp-requirements";
import { Loader2Icon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import type { OnboardingCopy, SimulateActionLabels, StandardOnboardingPanelStatus } from "./index";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function getLightsparkOnboardingCopy(
  t: Translate
): Record<StandardOnboardingPanelStatus, OnboardingCopy> {
  return {
    customer_verification_required: {
      title: t("DashboardPayments.lightspark.verificationRequiredTitle"),
      description: t("DashboardPayments.lightspark.verificationRequiredDescription"),
      icon: ShieldCheckIcon,
      iconClassName: "text-text-extra-high",
    },
    customer_verifying: {
      title: t("DashboardPayments.lightspark.verificationInReviewTitle"),
      description: t("DashboardPayments.lightspark.verificationInReviewDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-text-medium",
    },
    customer_verification_failed: {
      title: t("DashboardPayments.lightspark.verificationFailedTitle"),
      description: t("DashboardPayments.lightspark.verificationFailedDescription"),
      icon: XCircleIcon,
      iconClassName: "text-status-error-text",
    },
    funding_account_provisioning: {
      title: t("DashboardPayments.lightspark.fundingAccountProvisioningTitle"),
      description: t("DashboardPayments.lightspark.fundingAccountProvisioningDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-text-medium",
    },
    provisioning_failed: {
      title: t("DashboardPayments.lightspark.provisioningFailedTitle"),
      description: t("DashboardPayments.lightspark.provisioningFailedDescription"),
      icon: XCircleIcon,
      iconClassName: "text-status-error-text",
    },
    ready: {
      title: t("DashboardPayments.lightspark.readyTitle"),
      description: t("DashboardPayments.lightspark.readyDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-text-medium",
    },
  };
}

export function getLightsparkProvisioningDetail(t: Translate): Record<RampDirection, string> {
  return {
    onramp: t("DashboardPayments.lightspark.onrampProvisioningDetail"),
    offramp: t("DashboardPayments.lightspark.offrampProvisioningDetail"),
  };
}

export function getLightsparkSimulateLabels(t: Translate): SimulateActionLabels {
  return {
    idle: t("DashboardPayments.lightspark.simulateQuote"),
    busy: t("DashboardPayments.lightspark.simulating"),
    done: t("DashboardPayments.lightspark.quoteSimulated"),
  };
}
