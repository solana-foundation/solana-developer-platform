import type { RampDirection } from "@sdp/types/ramp-requirements";
import { FileSignatureIcon, Loader2Icon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import type { MuralOnboardingPanelStatus, OnboardingCopy, SimulateActionLabels } from "./index";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function getMuralOnboardingCopy(
  t: Translate
): Record<MuralOnboardingPanelStatus, OnboardingCopy> {
  return {
    terms_of_service_required: {
      title: t("DashboardPayments.mural.termsTitle"),
      description: t("DashboardPayments.mural.termsDescription"),
      icon: FileSignatureIcon,
      iconClassName: "text-primary",
    },
    customer_verification_required: {
      title: t("DashboardPayments.mural.verificationRequiredTitle"),
      description: t("DashboardPayments.mural.verificationRequiredDescription"),
      icon: ShieldCheckIcon,
      iconClassName: "text-primary",
    },
    customer_verifying: {
      title: t("DashboardPayments.mural.verificationInReviewTitle"),
      description: t("DashboardPayments.mural.verificationInReviewDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-secondary",
    },
    customer_verification_failed: {
      title: t("DashboardPayments.mural.verificationFailedTitle"),
      description: t("DashboardPayments.mural.verificationFailedDescription"),
      icon: XCircleIcon,
      iconClassName: "text-error",
    },
    funding_account_provisioning: {
      title: t("DashboardPayments.mural.fundingAccountProvisioningTitle"),
      description: t("DashboardPayments.mural.fundingAccountProvisioningDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-secondary",
    },
    ready: {
      title: t("DashboardPayments.mural.readyTitle"),
      description: t("DashboardPayments.mural.readyDescription"),
      icon: Loader2Icon,
      iconClassName: "animate-spin text-secondary",
    },
  };
}

export function getMuralProvisioningDetail(t: Translate): Record<RampDirection, string> {
  return {
    onramp: t("DashboardPayments.mural.onrampProvisioningDetail"),
    offramp: t("DashboardPayments.mural.offrampProvisioningDetail"),
  };
}

export function getMuralSimulateLabels(t: Translate): SimulateActionLabels {
  return {
    idle: t("DashboardPayments.mural.simulateDeposit"),
    busy: t("DashboardPayments.mural.simulating"),
    done: t("DashboardPayments.mural.depositSimulated"),
  };
}
